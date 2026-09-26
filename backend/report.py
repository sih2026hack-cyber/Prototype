"""Scoped ARGUS report: JSON stdin -> PDF stdout. No model calls or private drafts.

Every text field arrives already masked by the Node server (lib/profanity.mjs), so this
file only lays the analysis out. Fonts: ARGUS_REPORT_FONT (Latin), ARGUS_REPORT_FONT_BOLD,
ARGUS_REPORT_FONT_TAMIL; Windows defaults to Nirmala UI, Linux to Noto Sans.
"""
import io, json, os, re, sys
from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether, CondPageBreak
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.graphics.shapes import Drawing, Rect, Line, Circle, String, Wedge, PolyLine

data = json.load(sys.stdin)

# ---- fonts -----------------------------------------------------------------
WIN = os.name == 'nt'
def first(*paths):
    return next((p for p in paths if p and os.path.exists(p)), None)
FONTS = {
    'Argus': first(os.environ.get('ARGUS_REPORT_FONT'), r'C:\Windows\Fonts\Nirmala.ttc' if WIN else None, '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf'),
    'ArgusBold': first(os.environ.get('ARGUS_REPORT_FONT_BOLD'), r'C:\Windows\Fonts\NirmalaB.ttc' if WIN else None, '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'),
    'ArgusTa': first(os.environ.get('ARGUS_REPORT_FONT_TAMIL'), r'C:\Windows\Fonts\Nirmala.ttc' if WIN else None, '/usr/share/fonts/truetype/noto/NotoSansTamil-Regular.ttf'),
}
if not FONTS['Argus']:
    raise SystemExit('No report font found. Set ARGUS_REPORT_FONT.')
for name, path in FONTS.items():
    path = path or FONTS['Argus']
    pdfmetrics.registerFont(TTFont(name, path, subfontIndex=0, shapable=True) if path.endswith('.ttc') else TTFont(name, path, shapable=True))
pdfmetrics.registerFontFamily('Argus', normal='Argus', bold='ArgusBold', italic='Argus', boldItalic='ArgusBold')
GLYPHS = {n: pdfmetrics.getFont(n).face.charToGlyph for n in FONTS}
TAMIL = re.compile(r'[\u0B80-\u0BFF]+')

def markup(value, limit=None):
    """Escape text, drop glyphs no font has (emoji), and set Tamil runs in the Tamil font."""
    text = str(value if value is not None else '—').replace('\u2011', '-')
    if limit and len(text) > limit:
        text = text[:limit].rstrip() + '…'
    text = ''.join(c for c in text if c in '\n\t' or ord(c) in GLYPHS['Argus'] or ord(c) in GLYPHS['ArgusTa'])
    text = re.sub(r'[ \t]{2,}', ' ', text).strip()
    out, last = [], 0
    for m in TAMIL.finditer(text):
        out.append(escape(text[last:m.start()]))
        out.append('<font name="ArgusTa">' + escape(m.group()) + '</font>')
        last = m.end()
    out.append(escape(text[last:]))
    return ''.join(out).replace('\n', '<br/>')

# ---- palette and styles ----------------------------------------------------
NAVY, INK, MUTED, LINE, SOFT = HexColor('#17304a'), HexColor('#1d2b3a'), HexColor('#5f7384'), HexColor('#d9e2e8'), HexColor('#f3f6f8')
TEAL, BLUE, VIOLET, AMBER, RED, GREY = HexColor('#1f9d86'), HexColor('#3b7dd8'), HexColor('#7a5cc9'), HexColor('#d99a1e'), HexColor('#d9534f'), HexColor('#9aa7b2')
SENT = {'positive': TEAL, 'neutral': BLUE, 'negative': RED, 'unavailable': GREY}
PALETTE = [TEAL, BLUE, VIOLET, AMBER, RED, HexColor('#2f9fb3')]
def style(name, size=9.5, leading=None, color=INK, font='Argus', **kw):
    st = ParagraphStyle(name, fontName=font, fontSize=size, leading=leading or size * 1.45, textColor=color, **kw)
    st.shaping = True  # HarfBuzz shaping so Tamil vowel signs join their consonants
    return st
S = {
    'title': style('title', 22, 27, white, 'ArgusBold'),
    'subtitle': style('subtitle', 11, 15, HexColor('#dbe7f0')),
    'meta': style('meta', 8, 11, HexColor('#b9cbd9')),
    'h1': style('h1', 13.5, 18, NAVY, 'ArgusBold', spaceBefore=4),
    'h2': style('h2', 9.5, 13, NAVY, 'ArgusBold'),
    'body': style('body', 9, 13.5),
    'small': style('small', 7.8, 11, MUTED),
    'cell': style('cell', 8.2, 11.5),
    'cellb': style('cellb', 8.2, 11.5, INK, 'ArgusBold'),
    'kpi': style('kpi', 19, 22, NAVY, 'ArgusBold'),
    'kpil': style('kpil', 7.5, 10, MUTED),
    'tag': style('tag', 7, 9, HexColor('#9a6a00')),
}
def P(value, st='body', limit=None):
    return Paragraph(markup(value, limit), S[st])
def link(label, url, st='small'):
    if isinstance(url, str) and url.startswith('https://www.youtube.com/'):
        return Paragraph('<link href="' + escape(url, {'"': '&quot;'}) + '" color="#2b6cb0">' + markup(label) + '</link>', S[st])
    return P('', st)

W = 515  # content width (A4 with 40pt margins)
story = []

# ---- building blocks -------------------------------------------------------
def section(number, title, note=None):
    band = Table([[P(f'{number:02d}', 'h1'), P(title, 'h1')]], colWidths=[34, W - 34])
    band.setStyle(TableStyle([('LINEBELOW', (0, 0), (-1, 0), 1.2, NAVY), ('VALIGN', (0, 0), (-1, -1), 'BOTTOM'),
                              ('LEFTPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 4)]))
    items = [CondPageBreak(160), band, Spacer(1, 6)]
    if note:
        items += [P(note, 'small'), Spacer(1, 6)]
    story.extend(items)

def card(title, flowables, width, tag=None, framed=True):
    head = [P(title, 'h2')] + ([P(tag, 'tag')] if tag else [])
    t = Table([[h] for h in head] + [[f] for f in flowables], colWidths=[width])
    st = [('LEFTPADDING', (0, 0), (-1, -1), 9), ('RIGHTPADDING', (0, 0), (-1, -1), 9),
          ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
          ('TOPPADDING', (0, 0), (-1, 0), 9), ('BOTTOMPADDING', (0, -1), (-1, -1), 9), ('VALIGN', (0, 0), (-1, -1), 'TOP')]
    if framed:
        st += [('BOX', (0, 0), (-1, -1), 0.6, LINE), ('BACKGROUND', (0, 0), (-1, -1), SOFT)]
    t.setStyle(TableStyle(st))
    t._argus_card = (title, flowables, width, tag)
    return t

def row_of(cards, gap=10):
    """Equal-width boxes side by side with equal height: the frame belongs to the row's cells,
    so every box stretches to the tallest one."""
    inner = [card(*c._argus_card, framed=False) if hasattr(c, '_argus_card') else c for c in cards]
    cells, widths = [], []
    for i, c in enumerate(inner):
        if i:
            cells.append(''); widths.append(gap)
        cells.append(c); widths.append(box_width(len(inner), gap))
    grid = Table([cells], colWidths=widths)
    st = [('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
          ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0)]
    for col in range(0, len(cells), 2):
        st += [('BOX', (col, 0), (col, 0), 0.6, LINE), ('BACKGROUND', (col, 0), (col, 0), SOFT)]
    grid.setStyle(TableStyle(st))
    return grid

def box_width(n, gap=10):
    return (W - gap * (n - 1)) / n

def bars(items, width, color=TEAL, total=None, fmt=None, empty='No observations in this selection.'):
    """label / bar / value rows, aligned in a table."""
    items = [(l, v) for l, v in items if isinstance(v, (int, float))]
    if not items:
        return P(empty, 'small')
    total = total if total is not None else sum(v for _, v in items)
    peak = max(v for _, v in items) or 1
    label_w, value_w = width * 0.42, 46
    bar_w = max(20, width - label_w - value_w - 4)
    rows = []
    for i, (label, value) in enumerate(items):
        d = Drawing(bar_w, 9)
        d.add(Rect(0, 1.5, bar_w, 6, fillColor=LINE, strokeColor=None, rx=3, ry=3))
        c = color[i % len(color)] if isinstance(color, list) else color
        d.add(Rect(0, 1.5, max(3, bar_w * value / peak), 6, fillColor=c, strokeColor=None, rx=3, ry=3))
        shown = fmt(value) if fmt else (f'{value:g}' + (f' · {round(value / total * 100)}%' if total else ''))
        rows.append([P(label, 'cell', 40), d, P(shown, 'small')])
    t = Table(rows, colWidths=[label_w, bar_w + 4, value_w])
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0),
                           ('RIGHTPADDING', (0, 0), (-1, -1), 2), ('TOPPADDING', (0, 0), (-1, -1), 1.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 1.5),
                           ('ALIGN', (2, 0), (2, -1), 'RIGHT')]))
    return t

def data_table(header, rows, widths, zebra=True):
    t = Table([[P(h, 'cellb') for h in header]] + rows, colWidths=widths, repeatRows=1)
    st = [('LINEBELOW', (0, 0), (-1, 0), 0.8, NAVY), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5),
          ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
          ('LINEBELOW', (0, 1), (-1, -1), 0.3, LINE)]
    if zebra:
        st += [('BACKGROUND', (0, i), (-1, i), SOFT) for i in range(2, len(rows) + 1, 2)]
    t.setStyle(TableStyle(st))
    return t

def donut(counts, size=118):
    total = sum(counts.values()) or 1
    d = Drawing(size, size)
    cx = cy = size / 2
    start = 90
    for key in ['positive', 'neutral', 'negative', 'unavailable']:
        value = counts.get(key, 0)
        if not value:
            continue
        sweep = 360 * value / total
        d.add(Wedge(cx, cy, size / 2 - 2, start - sweep, start, fillColor=SENT[key], strokeColor=white, strokeWidth=1))
        start -= sweep
    d.add(Circle(cx, cy, size / 2 - 22, fillColor=white, strokeColor=None))
    d.add(String(cx, cy + 1, str(sum(counts.values())), fontName='ArgusBold', fontSize=18, fillColor=NAVY, textAnchor='middle'))
    d.add(String(cx, cy - 13, 'comments', fontName='Argus', fontSize=7.5, fillColor=MUTED, textAnchor='middle'))
    return d

def line_chart(buckets, width, height=120):
    points = [(i, b['score']) for i, b in enumerate(buckets) if isinstance(b.get('score'), (int, float))]
    if not points:
        return P('Not enough scored comments for a timeline.', 'small')
    left, right, top, bottom = 26, width - 6, height - 8, 24
    n = len(buckets)
    x = lambda i: (left + right) / 2 if n == 1 else left + i / (n - 1) * (right - left)
    y = lambda v: bottom + (v + 1) / 2 * (top - bottom)
    d = Drawing(width, height)
    for v in (-1, -0.5, 0, 0.5, 1):
        d.add(Line(left, y(v), right, y(v), strokeColor=LINE, strokeWidth=0.8 if v == 0 else 0.4, strokeDashArray=[3, 2] if v == 0 else None))
        d.add(String(left - 4, y(v) - 2.5, f'{v:g}', fontName='Argus', fontSize=6.5, fillColor=MUTED, textAnchor='end'))
    if len(points) > 1:
        d.add(PolyLine([c for i, v in points for c in (x(i), y(v))], strokeColor=BLUE, strokeWidth=1.4))
    for i, v in points:
        r = min(5, 2 + (buckets[i]['count'] ** 0.5) * 0.7)
        d.add(Circle(x(i), y(v), r, fillColor=RED if v < 0 else TEAL, strokeColor=white, strokeWidth=0.8))
    step = max(1, -(-n // 7))
    for i, b in enumerate(buckets):
        if i % step == 0 or i == n - 1:
            d.add(String(x(i), 8, str(b['label']), fontName='Argus', fontSize=6.5, fillColor=MUTED, textAnchor='middle'))
    return d

def stacked_chart(buckets, topics, width, height=130):
    keys = [t['key'] for t in topics]
    totals = [sum(b['topics'].get(k, 0) for k in keys) for b in buckets]
    if not buckets or not any(totals):
        return P('No dated topic observations.', 'small')
    left, right, top, bottom = 22, width - 4, height - 6, 22
    peak = max(totals) or 1
    slot = (right - left) / len(buckets)
    bw = min(34, slot * 0.66)
    d = Drawing(width, height)
    d.add(Line(left, bottom, right, bottom, strokeColor=LINE))
    for v in (0, -(-peak // 2), peak):
        d.add(String(left - 4, bottom + v / peak * (top - bottom) - 2.5, str(v), fontName='Argus', fontSize=6.5, fillColor=MUTED, textAnchor='end'))
    step = max(1, -(-len(buckets) // 7))
    for i, b in enumerate(buckets):
        x0, y0 = left + slot * i + (slot - bw) / 2, bottom
        for j, k in enumerate(keys):
            v = b['topics'].get(k, 0)
            if v:
                h = v / peak * (top - bottom)
                d.add(Rect(x0, y0, bw, h, fillColor=PALETTE[j % len(PALETTE)], strokeColor=white, strokeWidth=0.5))
                y0 += h
        if i % step == 0 or i == len(buckets) - 1:
            d.add(String(left + slot * i + slot / 2, 8, str(b['label']), fontName='Argus', fontSize=6.5, fillColor=MUTED, textAnchor='middle'))
    return d

LANG = {'en': 'English', 'ta': 'Tamil', 'hi': 'Hindi', 'te': 'Telugu', 'ml': 'Malayalam', 'kn': 'Kannada', 'bn': 'Bengali', 'mr': 'Marathi',
        'ur': 'Urdu', 'ms': 'Malay', 'id': 'Indonesian', 'gu': 'Gujarati', 'pa': 'Punjabi', 'und': 'Uncertain / mixed'}
COUNTRY = {'IN': 'India', 'US': 'United States', 'LK': 'Sri Lanka', 'MY': 'Malaysia', 'SG': 'Singapore', 'AE': 'UAE', 'GB': 'United Kingdom',
           'CA': 'Canada', 'AU': 'Australia', 'SA': 'Saudi Arabia', 'QA': 'Qatar', 'BD': 'Bangladesh', 'PK': 'Pakistan', 'NP': 'Nepal'}
def ist(value):
    try:
        t = datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(timezone(timedelta(hours=5, minutes=30)))
        return t.strftime('%d %b %Y, %I:%M %p IST')
    except ValueError:
        return str(value or 'Unknown')
def num(value):
    return f'{value:,}' if isinstance(value, int) else ('—' if value is None else str(value))

# ---- content ---------------------------------------------------------------
run, cov, summary = data['run'], data['coverage'], data['summary']
comments = cov['comments']
sent = summary['sentiment']
scored = [p for p in (data.get('activity') or {}).get('buckets', []) if isinstance(p.get('score'), (int, float))]
avg = (sum(b['score'] * b['scored'] for b in scored) / max(1, sum(b['scored'] for b in scored))) if scored else None
part = data.get('participation') or {}
topics = data.get('topics', [])
filters = data.get('filters') or {}

# cover band
cover = Table([[P('ARGUS · Audience intelligence report', 'meta')], [P(run.get('label') or 'Saved analysis', 'title', 140)],
               [P(f"Collected {ist(run.get('completed_at'))}  ·  Scope: " + (f"{filters.get('from') or 'start'} to {filters.get('to') or 'latest'}" if filters.get('from') or filters.get('to') else 'all dates') +
                  (f"  ·  Group: {filters.get('group').replace('_', ' ')}" if filters.get('group') not in (None, '', 'combined') else ''), 'meta')]],
              colWidths=[W])
cover.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), NAVY), ('LEFTPADDING', (0, 0), (-1, -1), 16), ('RIGHTPADDING', (0, 0), (-1, -1), 16),
                           ('TOPPADDING', (0, 0), (-1, 0), 14), ('BOTTOMPADDING', (0, -1), (-1, -1), 14)]))
story += [cover, Spacer(1, 12)]

def kpi(value, label):
    return [P(value, 'kpi'), P(label, 'kpil')]
neg_share = round(sent.get('negative', 0) / comments * 100) if comments else 0
tiles = [kpi(num(comments), 'comments & replies analysed'), kpi(num(part.get('commenters')), 'unique commenters'),
         kpi(str(len(topics)), 'topics discovered'), kpi('—' if avg is None else ('0.00' if abs(avg) < 0.005 else f'{avg:+.2f}'), f'average sentiment · {neg_share}% negative')]
def tile(a, b):
    t = Table([[a], [b]], colWidths=[box_width(4)])
    t.setStyle(TableStyle([('LEFTPADDING', (0, 0), (-1, -1), 10), ('TOPPADDING', (0, 0), (-1, 0), 9), ('BOTTOMPADDING', (0, -1), (-1, -1), 9)]))
    return t
story += [row_of([tile(a, b) for a, b in tiles]), Spacer(1, 8)]
story.append(P(f"A selected sample of public YouTube comments ({cov['videos']} video{'s' if cov['videos'] != 1 else ''}), not a census of all viewers. "
               "Abusive words are masked throughout this report.", 'small'))
for warning in run.get('warnings', []):
    story.append(P('Note: ' + warning, 'small'))
story.append(Spacer(1, 10))

# 1 sentiment
section(1, 'How people feel', 'Sentiment is scored per comment (RoBERTa first, MiniMax for difficult or non-English text). Emotions are model estimates and can overlap.')
legend = bars([(k.capitalize() if k != 'unavailable' else 'Unscored', sent.get(k, 0)) for k in ['positive', 'neutral', 'negative', 'unavailable'] if sent.get(k)],
              box_width(2) - 150, [SENT[k] for k in ['positive', 'neutral', 'negative', 'unavailable'] if sent.get(k)], total=comments)
left = Table([[donut(sent), legend]], colWidths=[128, box_width(2) - 146])
left.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0)]))
emotions = sorted(data.get('emotions', {}).items(), key=lambda kv: -kv[1])
story.append(row_of([card('Sentiment split', [left], box_width(2)),
                     card('Emotions in the sample', [bars([(k.capitalize(), v) for k, v in emotions], box_width(2) - 18, AMBER, total=comments)], box_width(2))]))
story.append(Spacer(1, 10))
activity = data.get('activity') or {'granularity': 'day', 'buckets': []}
unit = 'hour (IST)' if activity.get('granularity') == 'hour' else 'day'
story.append(card(f'Average sentiment per {unit}', [line_chart(activity['buckets'], W - 18), P('Dot size reflects the number of comments; red dots are net-negative periods.', 'small')], W))

# 2 audience
section(2, 'Who is participating', 'Participation and languages are counted from the comments. Segments count only people who describe themselves.')
tod = list((part.get('time_of_day_ist') or {}).items())
stats = Table([[P(num(part.get('commenters')), 'kpi'), P(num(part.get('repeat')), 'kpi'), P(num(part.get('replies')), 'kpi')],
               [P('commenters', 'kpil'), P('repeat', 'kpil'), P('replies', 'kpil')]], colWidths=[(box_width(3) - 18) / 3] * 3)
stats.setStyle(TableStyle([('LEFTPADDING', (0, 0), (-1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 1)]))
bw3 = box_width(3) - 18
part_card = [stats, Spacer(1, 6), P('When they comment (IST)', 'cellb'), bars([(k.split(' (')[0], v) for k, v in tod], bw3, TEAL)]
if part.get('abusive'):
    part_card.append(P(f"{part['abusive']} comment{'s' if part['abusive'] != 1 else ''} used abusive language (masked).", 'small'))
langs = sorted(summary.get('languages', {}).items(), key=lambda kv: -kv[1])
seg = data.get('audienceSegments') or {}
seg_body = [bars([(g['label'], g['count']) for g in seg.get('segments', [])], bw3, AMBER, total=seg.get('classified') or None,
                 empty='No self-described group large enough to show (minimum 3).')]
if seg.get('estimated'):
    seg_body.append(P(f"{seg.get('classified', 0)} of {seg['estimated']} comments described themselves; {seg.get('unstated', 0)} did not."
                      + (f" {seg['hidden_groups']} small group(s) hidden." if seg.get('hidden_groups') else ''), 'small'))
else:
    seg_body.append(P('Not estimated for this analysis yet.', 'small'))
story.append(row_of([card('Participation', part_card, box_width(3)),
                     card('Languages', [bars([(LANG.get(k, k), v) for k, v in langs], bw3, VIOLET, total=comments)], box_width(3)),
                     card('Audience segments', seg_body, box_width(3))]))
story.append(Spacer(1, 10))

report, est = data.get('audienceReport'), data.get('audienceEstimates') or {}
if report:
    dims = [(k, v) for k, v in report.get('dimensions', {}).items() if v][:3]
    story.append(P(f"Age, gender and country — {'YouTube Studio analytics' if report.get('source') == 'youtube_analytics' else 'voluntary survey'} · "
                   f"{report.get('population')} · {report.get('period')}. A separate population from the commenters; groups under 10 are hidden.", 'small'))
    story.append(Spacer(1, 4))
    if dims:
        story.append(row_of([card(k.capitalize() if k != 'region' else 'Country',
                                  [bars([(COUNTRY.get(r['label'], r['label']), r['percent']) for r in rows if not r.get('suppressed')],
                                        box_width(len(dims)) - 18, BLUE, total=100, fmt=lambda v: f'{v:g}%')], box_width(len(dims))) for k, rows in dims]))
elif est.get('estimated'):
    story.append(P(f"Age, gender and country are an AI estimate (low confidence, average {est.get('confidence')}) from {est['estimated']} comments. "
                   + est.get('note', ''), 'small'))
    story.append(Spacer(1, 4))
    boxes = []
    for key, title in (('age', 'Age'), ('gender', 'Gender'), ('region', 'Country'), ('state', 'State / region (India)')):
        dim = est['dimensions'].get(key)
        if not dim:
            continue
        body = [bars([(COUNTRY.get(r['label'], r['label']) if key == 'region' else r['label'], r['count']) for r in dim['rows']],
                     box_width(2) - 18, BLUE, total=dim['total'] or None, empty='No group large enough to show.'),
                P(f"{dim['unclear']} unclear" + (f" · {dim['hidden']} small group(s) hidden" if dim.get('hidden') else ''), 'small')]
        boxes.append(card(title, body, box_width(2), tag='AI estimate · low confidence'))
    for i in range(0, len(boxes), 2):
        story += [row_of(boxes[i:i + 2]), Spacer(1, 8)]
else:
    story.append(P('Age, gender and country: not available for this analysis. Estimate them in the dashboard or import YouTube Studio data.', 'small'))

# 3 topics
section(3, 'What people are talking about', 'Topics are clusters of semantically similar comments, labelled and summarised by MiniMax from representative comments.')
if topics:
    total_topic = sum(t['posts'] for t in topics) or 1
    rows = []
    for i, t in enumerate(topics[:10]):
        swatch = Drawing(10, 10)
        swatch.add(Rect(0, 1, 9, 9, fillColor=PALETTE[i % len(PALETTE)] if i < 4 else GREY, strokeColor=None, rx=2, ry=2))
        about = [P(t['topic'], 'cellb', 90)] + ([P(t['summary'], 'small', 420)] if t.get('summary') else [])
        if t.get('abusive'):
            about.append(P('Contains abusive language · masked', 'tag'))
        rows.append([swatch, about, P(f"{t['posts']}", 'cellb'), P(f"{round(t['posts'] / total_topic * 100)}%", 'small')])
    story.append(data_table(['', 'Topic', 'Mentions', 'Share'], rows, [16, W - 16 - 56 - 44, 56, 44]))
    story.append(Spacer(1, 10))
    story.append(KeepTogether(card(f"Topic activity per {unit}", [stacked_chart(activity['buckets'], topics[:4], W - 18),
                  P('  ·  '.join(f"■ {t['topic']}" for t in topics[:4]), 'small', 400)], W)))
    story.append(P(data.get('growth', {}).get('note', ''), 'small'))
else:
    story.append(P('No topics were discovered in this selection.', 'small'))

# 4 network
net = data.get('network') or {}
section(4, 'How the conversation connects', f"{len(net.get('nodes', []))} participants and videos, {len(net.get('edges', []))} observed comment and reply links. " + (net.get('limitations') or ''))
leaders = net.get('leaders', [])[:8]
if leaders:
    rows = []
    for a in leaders:
        sample = a.get('sample') or {}
        quote = [P('“' + (sample.get('text') or '') + '”', 'small', 180)] if sample.get('text') else [P('—', 'small')]
        if sample.get('url'):
            quote.append(link('View on YouTube', sample['url']))
        rows.append([P(a['label'], 'cell'), P(str(a.get('unique_incoming_repliers', 0)), 'cell'), P(str(a.get('comments', 0)), 'cell'),
                     P(num(a.get('likes')), 'cell'), quote])
    story.append(data_table(['Participant', 'Repliers', 'Comments', 'Likes', 'Most-liked comment'], rows, [92, 50, 58, 42, W - 242]))
    story.append(P('Participants are pseudonymous IDs; names are never stored.', 'small'))
else:
    story.append(P('No participant interactions were observed.', 'small'))

# 5 entities, severity, sources
section(5, 'Places, organisations and sources')
ents = data.get('entities', [])[:12]
sev = sorted((summary.get('event_severity') or {}).items(), key=lambda kv: kv[0])
story.append(row_of([card('Places & organisations mentioned', [bars([(f"{e['text']} ({e['label']})", e['count']) for e in ents], box_width(2) - 18, BLUE,
                                                                     empty='No civic place or organisation matches.'),
                                                                P('Mentions are not where commenters live.', 'small')], box_width(2)),
                     card('Event severity', [bars([(f'Severity {k}', v) for k, v in sev], box_width(2) - 18, RED, total=comments),
                                             P('Severity of the events described, separate from mood.', 'small')], box_width(2))]))
story.append(Spacer(1, 10))
videos = data.get('videos', [])
if videos:
    rows = []
    for v in videos[:12]:
        m = v.get('metrics') or {}
        rows.append([[P(v.get('title') or 'Video', 'cell', 110), link('Open video', v.get('source_url'))], P(v.get('channel_name') or '—', 'small', 40),
                     P(num(m.get('view_count')), 'cell'), P(num(m.get('like_count')), 'cell'), P(num(m.get('comment_count')), 'cell')])
    story.append(data_table(['Video', 'Channel', 'Views', 'Likes', 'Comments'], rows, [W - 90 - 60 * 2 - 70, 90, 60, 60, 70]))
evidence = data.get('evidence', [])[:8]
if evidence:
    story.append(Spacer(1, 10))
    rows = [[[P('“' + e['text'] + '”', 'small', 300), link('Open comment', e.get('url'))], P((e.get('sentiment') or '—').capitalize(), 'cell')] for e in evidence]
    story.append(data_table(['Representative comments', 'Sentiment'], rows, [W - 80, 80]))

# 6 methods
section(6, 'Method and limitations')
sources = summary.get('sentiment_sources') or {}
methods = {'transformer': 'RoBERTa', 'minimax': 'MiniMax escalation', 'vader': 'VADER fallback', 'skipped_empty': 'empty', 'unavailable': 'unavailable'}
topic_method = 'embedding community clustering (BERTopic unavailable on the server)' if any(t.get('source') == 'Embedding clusters' for t in topics) else 'BERTopic over the embeddings'
story.append(P('Sentiment sources: ' + (', '.join(f"{methods.get(k, k)} {v}" for k, v in sorted(sources.items(), key=lambda kv: -kv[1])) or '—') + '. '
               f"Embeddings: multilingual MiniLM, 384 dimensions ({cov.get('embeddings', 0)} records). Topics: {topic_method}. "
               'Topic labels, summaries, emotions and audience estimates: MiniMax.', 'body'))
storage = run.get('storage') or {}
story.append(P(f"Database: {storage.get('verified_rows', 'not verified')} NLP rows verified in Supabase for this run.", 'small'))
story.append(Spacer(1, 4))
for note in data.get('limitations', []):
    story.append(P('• ' + note, 'small'))

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE); canvas.line(40, 32, 555, 32)
    canvas.setFont('Argus', 7.5); canvas.setFillColor(MUTED)
    canvas.drawString(40, 20, 'ARGUS · Evidence-led audience intelligence · abusive words masked')
    canvas.drawRightString(555, 20, f'Page {doc.page}')
    canvas.restoreState()

output = io.BytesIO()
doc = SimpleDocTemplate(output, pagesize=(595, 842), rightMargin=40, leftMargin=40, topMargin=36, bottomMargin=46,
                        title='ARGUS audience analysis', author='ARGUS')
doc.build(story, onFirstPage=footer, onLaterPages=footer)
sys.stdout.buffer.write(output.getvalue())
