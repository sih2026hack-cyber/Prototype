import { settings } from './config.mjs';
import { cleanPost, redact } from './privacy.mjs';
export class ServiceError extends Error { constructor(message, status = 503) { super(message); this.status = status; } }
export async function requestJson(url, options = {}, label = 'Service', retries = 2) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeout || 90000) }); }
    catch { if(attempt<retries){await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));continue;}throw new ServiceError(`${label} could not be reached. Check the connection.`); }
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      await response.body?.cancel();
      const delay = Number(response.headers.get('retry-after')) || 2 ** attempt;
      if (delay > 10) throw new ServiceError(`${label} is rate limited. Retry later.`);
      await new Promise(resolve => setTimeout(resolve, delay * 1000)); continue;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = data.error?.errors?.[0]?.reason || data.code || '';
      throw new ServiceError(`${label} returned HTTP ${response.status}${reason ? ` (${reason})` : ''}.`, response.status === 429 ? 429 : 503);
    }
    return data;
  }
}
export async function minimax(messages, maxTokens = 1800) {
  if (!settings.miniKey) throw new ServiceError('MiniMax is not configured. Add MINIMAX_API_KEY to the server environment.');
  const data = await requestJson(settings.miniUrl, {
    method: 'POST', headers: { Authorization: `Bearer ${settings.miniKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: settings.miniModel, messages, temperature: 0.2, max_tokens: maxTokens }),
  }, 'MiniMax', 0);
  if (data.base_resp?.status_code) throw new ServiceError(`MiniMax rejected the request (code ${data.base_resp.status_code}). Check the API key, account region and balance.`);
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new ServiceError('MiniMax returned no answer.');
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
export function parseModelJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}
export async function collectYouTube({videoIds=settings.videoIds,maxComments=settings.maxPosts,get:providedGet}={}) {
  if (!settings.youtubeKey && !providedGet) throw new ServiceError('Add YOUTUBE_API_KEY to collect public comments.');
  const get = providedGet || ((resource, params) => requestJson(`https://www.googleapis.com/youtube/v3/${resource}?${new URLSearchParams({ ...params, key: settings.youtubeKey })}`, {}, 'YouTube'));
  let videos = videoIds.map(id => ({ id, title: 'Selected video' }));
  if (!videos.length) {
    const found = await get('search', { part: 'snippet', type: 'video', q: settings.query, order: 'relevance', maxResults: '3' });
    videos = (found.items || []).map(x => ({ id: x.id.videoId, title: redact(x.snippet.title) }));
  }
  const posts = []; const comments = []; const warnings = []; const seen = new Set();
  const fetchedAt = new Date().toISOString();
  if (!videos.length) return { posts, warnings, videos };
  // A video is a source post in its own right. Analyse its title + description.
  const details = await get('videos', { part: 'snippet,statistics,contentDetails', id: videos.map(v=>v.id).join(',') });
  videos = (details.items || []).map(v=>({id:v.id,title:redact(v.snippet.title)}));
  for (const v of details.items || []) {
    const s=v.snippet,stats=v.statistics||{};
    const counts=Object.fromEntries([['view_count','viewCount'],['like_count','likeCount'],['comment_count','commentCount']].filter(([,key])=>stats[key]!==undefined).map(([key,field])=>[key,Number(stats[field])]));
    const title=redact(s.title).replace(/@[\w.]+/g,'@user');
    const description=redact(s.description).replace(/@[\w.]+/g,'@user');
    posts.push(cleanPost({id:`youtube:video:${v.id}`,native_id:v.id,source:'youtube',content_kind:'video',
      text:`${title}\n\n${description}`,title,description,tags:(s.tags||[]).map(redact),
      created_at:s.publishedAt,lang:s.defaultLanguage||s.defaultAudioLanguage||'und',
      author_ref:s.channelId,source_url:`https://www.youtube.com/watch?v=${v.id}`,
      video_id:v.id,channel_id:s.channelId,channel_name:redact(s.channelTitle),parent_id:null,context_title:title,metrics:counts,duration:v.contentDetails?.duration,
      fetched_at:fetchedAt,is_seed:false}));
  }
  function addComment(comment,video,parentComment=null){
    if(seen.has(comment.id)||comments.length>=maxComments)return;
    seen.add(comment.id);const s=comment.snippet;
    comments.push(cleanPost({id:`youtube:${comment.id}`,native_id:comment.id,source:'youtube',
      content_kind:parentComment?'reply':'comment',text:s.textOriginal||s.textDisplay,
      created_at:s.publishedAt,updated_at:s.updatedAt,lang:'und',author_ref:s.authorChannelId?.value,
      source_url:`https://www.youtube.com/watch?v=${video.id}&lc=${encodeURIComponent(comment.id)}`,
      video_id:video.id,parent_id:parentComment?`youtube:${parentComment}`:video.id,
      channel_id:posts.find(p=>p.video_id===video.id)?.channel_id,channel_name:posts.find(p=>p.video_id===video.id)?.channel_name,
      context_title:video.title,metrics:{like_count:s.likeCount??null},fetched_at:fetchedAt,is_seed:false}));
  }
  for (const [index,video] of videos.entries()) {
    if(comments.length>=maxComments)break;
    const budget=Math.ceil((maxComments-comments.length)/(videos.length-index));
    const start=comments.length, replyParents=[];let pageToken='';
    // Reserve up to one third of each video's comment budget for replies.
    const topBudget=Math.max(1,Math.ceil(budget*2/3));
    do {
      let data;
      try{data=await get('commentThreads',{part:'snippet',videoId:video.id,order:'time',textFormat:'plainText',maxResults:String(Math.min(100,topBudget-(comments.length-start))),...(pageToken?{pageToken}:{})});}
      catch(error){warnings.push(`${video.id}: ${error.message}`);break;}
      for(const thread of data.items||[]){addComment(thread.snippet.topLevelComment,video);if(thread.snippet.totalReplyCount>0)replyParents.push(thread.snippet.topLevelComment.id);}
      pageToken=data.nextPageToken||'';
    }while(pageToken&&comments.length-start<topBudget);
    for(const parentId of replyParents){
      let replyPage='';
      do{
        if(comments.length-start>=budget)break;
        try{const r=await get('comments',{part:'snippet',parentId,textFormat:'plainText',maxResults:String(Math.min(100,budget-(comments.length-start))),...(replyPage?{pageToken:replyPage}:{})});for(const reply of r.items||[])addComment(reply,video,parentId);replyPage=r.nextPageToken||'';}
        catch(error){warnings.push(`${video.id} replies: ${error.message}`);break;}
      }while(replyPage&&comments.length-start<budget);
    }
    // Fill unused reply slots with more top-level comments when available.
    while(pageToken&&comments.length-start<budget){
      try{const r=await get('commentThreads',{part:'snippet',videoId:video.id,order:'time',textFormat:'plainText',maxResults:String(Math.min(100,budget-(comments.length-start))),pageToken});for(const thread of r.items||[])addComment(thread.snippet.topLevelComment,video);pageToken=r.nextPageToken||'';}
      catch(error){warnings.push(`${video.id}: ${error.message}`);break;}
    }
  }
  return {posts:[...posts,...comments],warnings,videos};
}
export async function collectX() {
  if (!settings.xToken) throw new ServiceError('Add X_BEARER_TOKEN and enable X API read access.');
  let token = ''; const posts = [];
  do {
    const params = new URLSearchParams({ query: settings.xQuery, max_results: String(Math.min(100, Math.max(10, settings.maxPosts - posts.length))), 'tweet.fields': 'created_at,lang,public_metrics,author_id', expansions: 'author_id', 'user.fields': 'location', ...(token ? { next_token: token } : {}) });
    const data = await requestJson(`https://api.x.com/2/tweets/search/recent?${params}`, { headers: { Authorization: `Bearer ${settings.xToken}` } }, 'X');
    const users = Object.fromEntries((data.includes?.users || []).map(u => [u.id, u]));
    for (const p of data.data || []) posts.push(cleanPost({ id: `x:${p.id}`, native_id: p.id, source: 'x', text: p.text, created_at: p.created_at, lang: p.lang, location: users[p.author_id]?.location || null, author_ref: p.author_id, source_url: `https://x.com/i/web/status/${p.id}`, metrics: p.public_metrics || {}, fetched_at: new Date().toISOString(), is_seed: false }));
    token = data.meta?.next_token || '';
  } while (token && posts.length < settings.maxPosts);
  return { posts: posts.slice(0, settings.maxPosts), warnings: [] };
}
