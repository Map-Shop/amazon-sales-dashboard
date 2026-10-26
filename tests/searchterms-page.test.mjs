// The Search Terms page's product names and product picker.
//
// A product's name is its line and then itself — "Wall Map - SOK - US
// Ranger" — and the page shows the last part alone. That only works if two
// lines never shorten to the same name unmarked, so the rule for telling them
// apart is pinned here against the account's real names.
//
// js/ad-searchterms.js is a bare script sharing one global scope, so it is
// wrapped here with the globals it expects and its functions handed back.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'ad-searchterms.js'), 'utf8');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

const escapeHtml = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const factory = new Function(
  'document', 'fetch', 'localStorage', 'accessToken', 'escapeHtml', 'formatNumber', 'formatCount',
  '_svTimeAgo', 'setTimeout', 'clearTimeout',
  `${src}
   return {
     stBuildProductLabels, stProductLabel, stProductPicker, stSplitProduct,
     setLabels(m) { stProductLabels = m; }
   };`
);
const api = factory({ getElementById: () => null, querySelectorAll: () => [] }, async () => ({}),
  { getItem: () => null, setItem() {}, removeItem() {} }, 'test-token', escapeHtml,
  (n) => String(n), (n) => String(n), () => 'just now', setTimeout, clearTimeout);

// The account's own product names, as of the October snapshot.
const NAMES = [
  'Classroom Map - BrightWay Pack US/World Advanced Physical', 'Classroom Map - BrightWay Set US/World Primary',
  'Map Packs',
  'Raised Relief - Brand/Display', 'Raised Relief - California', 'Raised Relief - US Ranger', 'Raised Relief - World Ranger',
  'Wall Map - SOK - Brand/Display', 'Wall Map - SOK - US Blank', 'Wall Map - SOK - US Ranger', 'Wall Map - SOK - World Ranger',
  'Wall Map - State - California', 'Wall Map - State - Texas',
  'Z - Archived 1', 'Z - Classroom Map - Kappa Sets', 'Z - Pins'
];
const portfolios = NAMES.map((name, i) => ({ id: `p${i}`, name }));
const labels = api.stBuildProductLabels(portfolios);
const by = (name) => labels.get(portfolios.find(p => p.name === name).id);

console.log('\nPRODUCT NAMES  — the line comes off, and two lines sharing a name are told apart');

ok(by('Wall Map - SOK - US Blank').label === 'US Blank' && by('Wall Map - SOK - US Blank').group === 'Wall Map - SOK',
   'the prefixes come off, and are kept as the line it belongs to');
ok(by('Classroom Map - BrightWay Set US/World Primary').label === 'BrightWay Set US/World Primary',
   'a one-part prefix too');
ok(by('Map Packs').label === 'Map Packs' && by('Map Packs').group === '', 'a name with no prefix is left alone');
ok(by('Wall Map - SOK - US Ranger').label === 'US Ranger (WM)' && by('Raised Relief - US Ranger').label === 'US Ranger (RR)',
   'a name two lines share carries its line\'s initials', 'US Ranger is a wall map and a raised relief');
ok(by('Wall Map - State - California').label === 'California (WM)' && by('Raised Relief - California').label === 'California (RR)',
   'across the SOK and State wall maps alike: the initials are of the first part');
ok(by('Wall Map - SOK - Brand/Display').label === 'Brand/Display (WM)' && by('Wall Map - State - Texas').label === 'Texas',
   'and only where there is a clash');
ok(by('Z - Classroom Map - Kappa Sets').label === 'Kappa Sets' && by('Z - Pins').group === 'Z',
   'archived lines shorten the same way');

{
  const clash = api.stBuildProductLabels([
    { id: 'a', name: 'Wall Map - SOK - Ohio' }, { id: 'b', name: 'Wall Map - State - Ohio' }]);
  ok(clash.get('a').label === 'Ohio (Wall Map - SOK)' && clash.get('b').label === 'Ohio (Wall Map - State)',
     'two lines with the same initials are told apart by the whole line instead');
}

api.setLabels(labels);
ok(api.stProductLabel('nope', 'Wall Map - SOK - Gone Product') === 'Gone Product',
   'a product missing from the list still shortens its own name');
ok(api.stProductLabel(null, null) === '—', 'and no product at all reads as a dash');

console.log('\nTHE PICKER  — lines first, each opening onto its products by their short names');

{
  const current = portfolios.find(p => p.name === 'Raised Relief - US Ranger').id;
  const html = api.stProductPicker('ng', portfolios, current);
  const groups = [...html.matchAll(/<div class="st-pick-group">\s*<span>([^<]+)<\/span>/g)].map(m => m[1]);
  ok(groups.join(' | ') === 'Classroom Map | Raised Relief | Wall Map - SOK | Wall Map - State | Z | Z - Classroom Map',
     'one entry per line, in order', groups.join(' | '));
  const rr = html.slice(html.indexOf('<span>Raised Relief</span>'));
  const rrItems = [...rr.slice(0, rr.indexOf('</div>')).matchAll(/data-st-pick-value="[^"]*">([^<]+)</g)].map(m => m[1]);
  ok(rrItems.join(', ') === 'Brand/Display, California, US Ranger, World Ranger',
     'a line\'s products by their short names, without the initials — the line already says which',
     rrItems.join(', '));
  ok(/class="st-pick-item active" data-st-pick-value="[^"]+">US Ranger</.test(html),
     'the product picked is marked');
  ok(/<span class="st-pick-current">US Ranger \(RR\)<\/span>/.test(html) &&
     /title="Raised Relief - US Ranger"/.test(html),
     'and named on the button with its initials, the full name on hover');
  ok(html.indexOf('>All products<') < html.indexOf('st-pick-group'), 'All products comes first');
  ok(/data-st-pick-value="[^"]+">Map Packs</.test(html.slice(html.lastIndexOf('</div>\n              </div>'))),
     'a product with no line is listed on its own, after the lines');
  ok(/data-st-pick="ng"/.test(html) && /data-st-pick="tg"/.test(api.stProductPicker('tg', portfolios, '')),
     'each picker knows which tab\'s filter it sets');
  ok(/<span class="st-pick-current">All products<\/span>/.test(api.stProductPicker('tg', portfolios, '')),
     'with nothing picked the button says All products');
}

console.log(fails === 0 ? '\nsearchterms page: all assertions pass\n' : `\nsearchterms page: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
