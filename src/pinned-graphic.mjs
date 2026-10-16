import { GROUPS, formatDate } from './schedule.mjs';

export const PINNED_GRAPHIC_VERSION = 1;
export const PINNED_GRAPHIC_WIDTH = 2400;
export const PINNED_GRAPHIC_HEIGHT = 1510;

const xml = value => String(value ?? '').replace(/&/g, '&amp;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const HOURS = Array.from({length:24}, (_, i) =>
  String(i).padStart(2,'0') + '–' + String(i+1).padStart(2,'0'));

export function hasConfirmedGraphic(byGroup) {
  return GROUPS.every(group => byGroup?.[group]?.mode === 'fact' &&
    Array.isArray(byGroup[group].confirmed));
}

export function outageHalves(periods) {
  return Array.from({length:48}, (_, slot) => {
    const start = slot * 30;
    return (periods || []).some(p => p.start <= start && p.end >= start + 30);
  });
}

export function graphicFingerprint(date, byGroup, emergency) {
  return JSON.stringify({
    version: PINNED_GRAPHIC_VERSION, date,
    groups: hasConfirmedGraphic(byGroup) ?
      GROUPS.map(g => [g, (byGroup[g].confirmed || []).map(p => [p.start,p.end])]) : null,
    emergency: emergency?.active ? {
      kind:emergency.kind, scope:emergency.scope,
      districts:[...(emergency.districts || [])].sort()
    } : null
  });
}

function plug(cx,cy,size=1) {
  return '<g transform="translate('+cx+' '+cy+') scale('+size+')" ' +
    'fill="none" stroke="#273746" stroke-width="3.5" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M-6-14V-7 M6-14V-7 M-11-7H11V-1C11 6 6 11 0 11V16"/>' +
    '<path d="M-15-16L15 16" stroke-width="4.5"/></g>';
}

function drawCell(x,y,width,height,first,second) {
  let result='';
  if(first) result += '<rect x="'+x+'" y="'+y+'" width="'+(width/2)+'" height="'+height+'" fill="#d1d5da"/>';
  if(second) result += '<rect x="'+(x+width/2)+'" y="'+y+'" width="'+(width/2)+'" height="'+height+'" fill="#d1d5da"/>';
  if(first && second) result+=plug(x+width/2,y+height/2,.95);
  else if(first || second) {
    const iconX=x+(first?width/4:width*3/4);
    result+=plug(iconX,y+height/2,.68);
    result+='<line x1="'+(x+width/2)+'" y1="'+y+'" x2="'+(x+width/2)+'" y2="'+(y+height)+
      '" stroke="#b3bbc3" stroke-width="1.5"/>';
  }
  return result;
}

export function renderPinnedGraphicSvg(date, byGroup, emergency = null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid Kyiv date for image');
  const confirmed = hasConfirmedGraphic(byGroup);
  const w=PINNED_GRAPHIC_WIDTH,h=PINNED_GRAPHIC_HEIGHT;
  const x0=32,gridX=290,cell=85,tableY=226,header=170,rowH=70;
  const totalW=gridX+cell*24-x0;
  const endY=tableY+header+GROUPS.length*rowH;
  const rows=[
    '<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'">',
    '<rect width="'+w+'" height="'+h+'" fill="#ffffff"/>',
    '<text x="'+(w/2)+'" y="96" text-anchor="middle" font-size="67" font-family="DejaVu Sans, sans-serif" fill="#17212b" font-weight="700">Графік відключень на:</text>',
    '<text x="'+(w/2)+'" y="163" text-anchor="middle" font-size="43" font-family="DejaVu Sans, sans-serif" fill="#394957">'+xml(formatDate(date))+'</text>',
    '<rect x="'+x0+'" y="'+tableY+'" width="'+totalW+'" height="'+(endY-tableY)+'" rx="17" fill="#fff" stroke="#aeb5bd" stroke-width="2"/>',
    '<rect x="'+(x0+1)+'" y="'+(tableY+1)+'" width="'+(totalW-2)+'" height="'+(header-1)+'" rx="16" fill="#f8f9fa"/>'
  ];
  // Striping and exact 30-minute outage segments in every hourly cell.
  for(let row=0;row<GROUPS.length;row++){
    const y=tableY+header+row*rowH, group=GROUPS[row];
    rows.push('<rect x="'+(x0+1)+'" y="'+y+'" width="'+(totalW-2)+'" height="'+rowH+'" fill="'+(row%2?'#fafbfc':'#ffffff')+'"/>');
    if(confirmed){
      const halves=outageHalves(byGroup[group].confirmed);
      for(let hr=0;hr<24;hr++){
        const a=halves[hr*2], b=halves[hr*2+1];
        if(a||b) rows.push(drawCell(gridX+hr*cell,y,cell,rowH,a,b));
      }
    }
    rows.push('<text x="54" y="'+(y+47)+'" font-family="DejaVu Sans, sans-serif" font-weight="600" font-size="32" fill="#25303b">Підгрупа '+xml(group)+'</text>');
  }
  // Header text, hour labels and thin grid — matched to the supplied screenshot.
  rows.push('<text x="55" y="'+(tableY+68)+'" font-family="DejaVu Sans, sans-serif" font-size="31" font-weight="600" fill="#283747">Часові</text>');
  rows.push('<text x="55" y="'+(tableY+111)+'" font-family="DejaVu Sans, sans-serif" font-size="31" font-weight="600" fill="#283747">проміжки</text>');
  for(let hr=0;hr<24;hr++){
    const x=gridX+hr*cell,tx=x+cell/2,ty=tableY+header-18;
    rows.push('<text transform="translate('+tx+' '+ty+') rotate(-90)" text-anchor="start" font-family="DejaVu Sans, sans-serif" font-size="28" fill="#1b2733">'+HOURS[hr]+'</text>');
  }
  rows.push('<line x1="'+x0+'" y1="'+(tableY+header)+'" x2="'+(x0+totalW)+'" y2="'+(tableY+header)+'" stroke="#aeb5bd" stroke-width="2"/>');
  for(let row=1;row<GROUPS.length;row++){
    const y=tableY+header+row*rowH;
    rows.push('<line x1="'+x0+'" y1="'+y+'" x2="'+(x0+totalW)+'" y2="'+y+'" stroke="#c0c5ca" stroke-width="1.3"/>');
  }
  for(let hr=0;hr<=24;hr++){
    const x=gridX+hr*cell;
    rows.push('<line x1="'+x+'" y1="'+tableY+'" x2="'+x+'" y2="'+endY+'" stroke="#b5bcc4" stroke-width="1.4"/>');
  }
  if(!confirmed){
    rows.push('<rect x="'+(gridX+140)+'" y="'+(tableY+header+250)+'" width="1740" height="180" rx="25" fill="#fff4db" stroke="#ebbf65" stroke-width="3"/>');
    rows.push('<text x="1450" y="'+(tableY+header+352)+'" text-anchor="middle" font-size="49" font-weight="700" font-family="DejaVu Sans, sans-serif" fill="#674d17">Очікуємо підтверджений графік ДТЕК</text>');
  }
  // Legend clarifies that blank means no scheduled cut, not verified supply.
  const ly=endY+64;
  rows.push('<rect x="48" y="'+(ly-32)+'" width="38" height="38" fill="#d1d5da" stroke="#b5bcc4" rx="3"/>');
  rows.push('<text x="105" y="'+ly+'" font-size="27" font-family="DejaVu Sans, sans-serif" fill="#3a4958">Планове відключення</text>');
  rows.push('<rect x="560" y="'+(ly-32)+'" width="38" height="38" fill="#ffffff" stroke="#b5bcc4" rx="3"/>');
  rows.push('<text x="618" y="'+ly+'" font-size="27" font-family="DejaVu Sans, sans-serif" fill="#3a4958">Відключень за графіком немає</text>');
  rows.push('<rect x="1360" y="'+(ly-32)+'" width="19" height="38" fill="#d1d5da"/><rect x="1379" y="'+(ly-32)+'" width="19" height="38" fill="#fff" stroke="#b5bcc4"/>');
  rows.push('<text x="1422" y="'+ly+'" font-size="27" font-family="DejaVu Sans, sans-serif" fill="#3a4958">30 хв без світла</text>');
  const statusY=1375;
  if(emergency?.active){
    const districts=(emergency.districts || []).map(d=>d+' район').join(', ');
    const context=districts || 'окремі території Київщини';
    rows.push('<rect x="40" y="'+statusY+'" width="2320" height="98" rx="17" fill="#fff0eb" stroke="#e7b2a2" stroke-width="2"/>');
    rows.push('<text x="68" y="'+(statusY+39)+'" font-size="28" font-family="DejaVu Sans, sans-serif" font-weight="700" fill="#9a3626">УВАГА! '+(emergency.kind==='екстрені'?'Екстрені':'Аварійні')+' відключення: '+xml(context)+'</text>');
    rows.push('<text x="68" y="'+(statusY+77)+'" font-size="25" font-family="DejaVu Sans, sans-serif" fill="#7b463c">'+(emergency.kind==='екстрені'?'Планові графіки в зазначених районах не діють.':'Можливі відключення поза графіком.')+'</text>');
  } else {
    rows.push('<text x="48" y="1435" font-size="28" font-family="DejaVu Sans, sans-serif" fill="#526273">Планові години за підтвердженими даними ДТЕК • Фактична наявність світла може відрізнятися</text>');
  }
  rows.push('</svg>');
  return rows.join('');
}

export function pinnedPhotoCaption(date, confirmed, emergency) {
  const [year,month,day]=date.split('-');
  let caption='📌 <b>Графік відключень на '+day+'.'+month+'.'+year+'</b>\n';
  caption+=confirmed?'Усі 12 підгруп • планові години ДТЕК':'Очікуємо підтверджений графік ДТЕК';
  if(emergency?.active){
    caption+='\n\n⚠️ <b>'+ (emergency.kind==='екстрені'?'Екстрені':'Аварійні')+' відключення.</b> ';
    caption+=emergency.kind==='екстрені'?'У зазначених на зображенні районах графік не діє.':'Можливі відключення поза графіком.';
  }
  return caption;
}

export async function renderPinnedGraphicPng(date,byGroup,emergency) {
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(renderPinnedGraphicSvg(date,byGroup,emergency)))
    .png({compressionLevel:8}).toBuffer();
}
