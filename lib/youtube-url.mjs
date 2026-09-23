import {ServiceError} from './providers.mjs';
const invalid=()=>new ServiceError('Use a YouTube video, Shorts, @handle, /channel/ID or /user/name URL.',400);
export function parseYouTubeURL(input){
  if(typeof input!=='string'||input.length>2048)throw invalid();
  let u;try{u=new URL(input.trim());}catch{throw invalid();}
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port)throw invalid();
  const hosts=['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'];if(!hosts.includes(u.hostname))throw invalid();
  const parts=u.pathname.split('/').filter(Boolean);let id;
  if(u.hostname.endsWith('youtu.be'))id=parts.length===1?parts[0]:null;
  else if(parts[0]==='watch')id=u.searchParams.get('v');
  else if(['shorts','live','embed'].includes(parts[0]))id=parts[1];
  if(id){if(!/^[\w-]{11}$/.test(id))throw invalid();return {kind:'video',id,url:`https://www.youtube.com/watch?v=${id}`,key:`video:${id}`};}
  if(parts[0]?.startsWith('@')&&parts[0].length>1){let handle;try{handle=decodeURIComponent(parts[0]);}catch{throw invalid();}if(/[\s/?#]/u.test(handle))throw invalid();return{kind:'channel',forHandle:handle,url:`https://www.youtube.com/${encodeURIComponent(handle).replace('%40','@')}`};}
  if(parts[0]==='channel'&&/^UC[\w-]{22}$/.test(parts[1]||''))return{kind:'channel',id:parts[1],url:`https://www.youtube.com/channel/${parts[1]}`};
  if(parts[0]==='user'&&/^[\w.-]{1,100}$/.test(parts[1]||''))return{kind:'channel',forUsername:parts[1],url:`https://www.youtube.com/user/${parts[1]}`};
  throw invalid();
}
export async function resolveYouTube(input,get){
  const parsed=parseYouTubeURL(input);
  if(parsed.kind==='video')return {...parsed,label:parsed.id,videoIds:[parsed.id]};
  const filter=parsed.id?{id:parsed.id}:parsed.forHandle?{forHandle:parsed.forHandle}:{forUsername:parsed.forUsername};
  const result=await get('channels',{part:'snippet,contentDetails',...filter});const c=result.items?.[0];
  if(!c)throw new ServiceError('YouTube channel not found.',404);
  const playlist=c.contentDetails?.relatedPlaylists?.uploads;if(!playlist)throw new ServiceError('This channel has no public uploads.',404);
  const recent=await get('playlistItems',{part:'contentDetails',playlistId:playlist,maxResults:'5'});
  const videoIds=[...new Set((recent.items||[]).map(x=>x.contentDetails?.videoId).filter(Boolean))];
  if(!videoIds.length)throw new ServiceError('No public uploads found for this channel.',404);
  return {kind:'channel',id:c.id,key:`channel:${c.id}`,url:`https://www.youtube.com/channel/${c.id}`,label:c.snippet.title,videoIds};
}
