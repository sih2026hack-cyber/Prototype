"""Scoped ARGUS report: JSON stdin -> PDF stdout. No model calls or private drafts."""
import io, json, os, sys
from datetime import date
from xml.sax.saxutils import escape
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, KeepTogether
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.graphics.shapes import Drawing, Rect, Line, Circle, String

data = json.load(sys.stdin)
font_path = os.environ.get('ARGUS_REPORT_FONT', r'C:\Windows\Fonts\Nirmala.ttc')
pdfmetrics.registerFont(TTFont('Argus', font_path, subfontIndex=0, shapable=True))
font = pdfmetrics.getFont('Argus')
styles = getSampleStyleSheet()
for s in styles.byName.values():
    s.fontName='Argus'; s.textColor=HexColor('#183144')
styles['BodyText'].fontSize=10; styles['BodyText'].leading=15
styles['BodyText'].shaping=True
styles.add(ParagraphStyle('SmallArgus',parent=styles['BodyText'],fontSize=8,leading=12,textColor=HexColor('#496373')))
story=[]
def clean(value):
    text=str(value if value is not None else 'Unavailable').replace('\u2011','-')
    return ''.join(c if c in '\n\t' or ord(c) in font.face.charToGlyph else '[symbol]' for c in text)
def para(value,style='BodyText'):
    return Paragraph(escape(clean(value)).replace('\n','<br/>'),styles[style])
def add(value,style='BodyText'):
    p=para(value,style); gap=Spacer(1,7)
    if style.startswith('Heading'): p.keepWithNext=1; gap.keepWithNext=1
    story.extend([p,gap])
def heading(label):add(label,'Heading2')
def bars(items):
    items=list(items)[:12]
    if not items:add('No supported observations in this selection.');return
    maximum=max([v for _,v in items if isinstance(v,(int,float))] or [1]) or 1
    for label,value in items:
        d=Drawing(460,11);d.add(Rect(0,0,460,7,fillColor=HexColor('#e4ebef'),strokeColor=None))
        if isinstance(value,(int,float)):d.add(Rect(0,0,460*value/maximum,7,fillColor=HexColor('#259b88'),strokeColor=None))
        story.append(KeepTogether([para(f'{label}: {value if value is not None else "Suppressed / unavailable"}','SmallArgus'),d,Spacer(1,7)]))
def timeline(items,key='score'):
    values=[(i,p[key]) for i,p in enumerate(items) if isinstance(p.get(key),(int,float))]
    if not values:add('Insufficient scored observations for a timeline.');return
    d=Drawing(470,140); maximum=max([abs(v) for _,v in values]+[1])
    dates=[date.fromisoformat(p['date']).toordinal() for p in items];span=max(1,dates[-1]-dates[0])
    def x(i):return 10+(dates[i]-dates[0])/span*450
    d.add(Line(10,65,460,65,strokeColor=HexColor('#ccd8df')))
    for i,v in values:d.add(Circle(x(i),65+v/maximum*50,3,fillColor=HexColor('#259b88'),strokeColor=None))
    for (i,a),(j,b) in zip(values,values[1:]):
        if dates[j]-dates[i]==1:d.add(Line(x(i),65+a/maximum*50,x(j),65+b/maximum*50,strokeColor=HexColor('#259b88')))
    d.add(String(10,5,str(items[0]['date']),fontName='Argus',fontSize=8));d.add(String(365,5,str(items[-1]['date']),fontName='Argus',fontSize=8));story.append(d)
def link(label,url):
    if isinstance(url,str) and url.startswith('https://www.youtube.com/'):
        story.append(Paragraph('<link href="'+escape(url,{'"':'&quot;'})+'" color="#216793">'+escape(clean(label))+'</link>',styles['SmallArgus']))
run=data['run'];coverage=data['coverage']
add('ARGUS / Audience intelligence','Title')
add(run.get('label','Saved analysis'),'Heading2')
add('A selected public commenter sample, not a census of viewers or followers.')
add(f"Collected: {run.get('completed_at','Unknown')} | Run: {run['id']}",'SmallArgus')
add('Filters: '+json.dumps(data.get('filters',{}),ensure_ascii=False),'SmallArgus')
heading('Executive summary')
add(f"{coverage['videos']} video records, {coverage['comments']} comments/replies and {len(data['topics'])} non-outlier topics in the selected scope. {coverage['embeddings']} records have 384-dimensional embeddings.")
for warning in run.get('warnings',[]):add('Coverage warning: '+warning,'SmallArgus')
heading('1 / Sentiment and emotions')
bars(data['summary']['sentiment'].items());timeline(data['timeline'])
add('Timeline: daily mean of scored comments by publication date; gaps are not observations.','SmallArgus')
bars(data['emotions'].items());add('Emotion labels are model estimates, can overlap, and are not a clinical assessment.','SmallArgus')
heading('2 / Audience profile')
bars(data['summary']['languages'].items())
add('Detected comment language is not nationality. Topic participation is interest, not occupation.')
part=data.get('participation')
if part:
    add(f"Participation: {part['commenters']} unique commenters, {part['repeat']} commented more than once; {part['top_level']} top-level comments and {part['replies']} replies." + (f" {part['abusive']} comments contained abusive language (masked in this report)." if part.get('abusive') else ''))
    heading('Commenting time of day (IST)');bars(part['time_of_day_ist'].items())
seg=data.get('audienceSegments')
if seg and seg.get('estimated'):
    heading('Audience segments (self-described)')
    bars([(f"{g['label']} (conf {g['confidence']})",g['count']) for g in seg['segments']])
    add(f"{seg['classified']} of {seg['estimated']} comments described themselves; {seg['unstated']} did not. {seg['note']}",'SmallArgus')
report=data.get('audienceReport')
if report:
    add(f"Imported report: {report.get('source')} | Population: {report.get('population')} | Period: {report.get('period')}")
    add('This imported population is separate from the commenter sample. Categories under ten known respondents are suppressed.','SmallArgus')
    for dimension,rows in report.get('dimensions',{}).items():heading(dimension);bars([(r['label'],r.get('percent')) for r in rows])
elif (data.get('audienceEstimates') or {}).get('estimated'):
    est=data['audienceEstimates']
    add(f"Age, gender and country below are an AI estimate (low confidence, average {est.get('confidence')}) from {est['estimated']} comments. {est['note']}")
    for dim,title in [('age','Age (AI estimate)'),('gender','Gender (AI estimate)'),('region','Country (AI estimate)')]:
        heading(title);bars([(r['label'],r['count']) for r in est['dimensions'][dim]['rows']])
else:add('Age, gender and audience geography: unavailable. Import authorized aggregate channel analytics or a voluntary survey; no demographic predictions are fabricated.')
heading('3 / Topics and observed discussion')
bars([(t['topic'],t['posts']) for t in data['topics']])
for t in data['topics'][:10]:
    if t.get('summary'):add(t['topic']+': '+t['summary'],'SmallArgus')
add(data['growth']['note'],'SmallArgus')
heading('Daily sampled comment volume');timeline(data['timeline'],'count')
heading('4 / Interaction network and influence')
net=data['network'];add(f"{len(net['nodes'])} observed nodes and {len(net['edges'])} record-backed edges. {net['limitations']}")
nodes=net['nodes'][:16];pos={};d=Drawing(470,210)
for i,node in enumerate(nodes):pos[node['id']]=(35+(i%4)*115,180-(i//4)*48)
for edge in net['edges']:
    if edge['from'] in pos and edge['to'] in pos:
        a,b=pos[edge['from']],pos[edge['to']];d.add(Line(*a,*b,strokeColor=HexColor('#b4cbd1')))
for i,node in enumerate(nodes):
    x,y=pos[node['id']];d.add(Circle(x,y,5,fillColor=HexColor('#259b88' if node['kind']=='author' else '#3b75aa'),strokeColor=None));d.add(String(x-15,y-15,('P' if node['kind']=='author' else 'V')+str(i+1),fontName='Argus',fontSize=8))
story.append(d);add(f"Network illustration shows {len(nodes)} of {len(net['nodes'])} nodes and edges whose endpoints are shown. P = pseudonymous participant; V = video. Direction and complete edge evidence remain in the dataset.",'SmallArgus')
bars([(a['label'],a['unique_incoming_repliers']) for a in net['leaders']])
for a in net['leaders'][:5]:add(f"{a['label']}: {a['comments']} comments; likes {a['likes'] if a['likes'] is not None else 'unavailable'}",'SmallArgus')
heading('Methods and database verification')
add('NLP/NER: existing language and spaCy/gazetteer pipeline. Sentiment: RoBERTa with MiniMax escalation. Embeddings: multilingual Sentence-Transformers, 384 dimensions. Topic discovery: BERTopic with PCA and HDBSCAN, not UMAP. MiniMax summaries use at most five representative records per topic; keyword labels remain when summarization is unavailable.')
storage=run.get('storage',{});add(f"Whole-run last verified NLP rows: {storage.get('verified_rows','not verified')}; metadata rows: {storage.get('metadata_verified',storage.get('metadata_written','not verified'))}. These are run-level sync figures, not date-filtered counts.",'SmallArgus')
for error in storage.get('errors',[]):add(error,'SmallArgus')
heading('Contextual entities and event severity')
add(', '.join(e['text'] for e in data['entities'][:20]) or 'No civic gazetteer matches.','SmallArgus')
add('Place mentions are not commenter residence. Event severity is distinct from writer sentiment.','SmallArgus')
bars([(f'Severity {k}',v) for k,v in data['summary']['event_severity'].items()])
heading('Sources and representative evidence')
for video in data['videos']:
    add(video.get('title','Video'),'SmallArgus');link('Open source video',video.get('source_url'))
    add('Public statistics: '+json.dumps(video.get('metrics',{})),'SmallArgus')
for record in data['evidence']:
    add(record['text'][:450],'SmallArgus');link('Open original comment',record['url'])
heading('Limitations')
for note in data['limitations']:add(note,'SmallArgus')
add('YouTube-only milestone. X and authorized Telegram ingestion remain required for the complete hackathon platform brief.','SmallArgus')
def footer(canvas,doc):
    canvas.saveState();canvas.setFont('Argus',8);canvas.setFillColor(HexColor('#496373'));canvas.drawString(40,25,'ARGUS / Evidence-led audience intelligence');canvas.drawRightString(555,25,str(doc.page));canvas.restoreState()
output=io.BytesIO();doc=SimpleDocTemplate(output,pagesize=(595,842),rightMargin=45,leftMargin=45,topMargin=42,bottomMargin=45,title='ARGUS audience analysis',author='ARGUS')
doc.build(story,onFirstPage=footer,onLaterPages=footer);sys.stdout.buffer.write(output.getvalue())
