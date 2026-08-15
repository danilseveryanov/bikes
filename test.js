/* Checks the aggregation math that the money charts render.
 * Loads the REAL functions out of src/app.html — not a copy — so the test
 * cannot drift from what ships.
 *
 * Run: node test.js
 */
const fs = require("fs");
const assert = require("assert");

const html = fs.readFileSync(__dirname + "/src/app.html", "utf8");
const cut = (from, to) => {
  const a = html.indexOf(from);
  // search for the closing marker AFTER the opening one — the stylesheet has its
  // own section comments and some names repeat there
  const b = html.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, `markers not found: ${from}`);
  return html.slice(a, b);
};
const src = cut("/* ============================================================ aggregation */",
                "/* ============================================================ charts");

const bikes = JSON.parse(fs.readFileSync(__dirname + "/data/bikes.json", "utf8"));
const rules = JSON.parse(fs.readFileSync(__dirname + "/data/maintenance.json", "utf8"));

const CATS = { drivetrain:{}, brakes:{}, wheels:{}, suspension:{}, consumables:{} };
const BIKE = Object.fromEntries(bikes.map(b => [b.id, b]));
const RULE = Object.fromEntries(rules.map(r => [r.id, r]));

const doc = { odo:{}, annualKm:{}, ownership:{}, events:[], checks:{}, photos:{} };
const DOC = () => doc;

const api = new Function("DOC","BIKE","RULE","CATS","RULES","BIKES",
  src + `; return {yearCost,categorySplit,costPerKm,forecast,purchaseTotal,evCost,
                   liveEvents,eventsOf,matchComponent,defaultPartCost,dueStatus,
                   ownershipOf,isOwned,ownedBikes,soldBikes,netCost,attention};`
)(DOC, BIKE, RULE, CATS, rules, bikes);

const A = "faraoll-g50", B = "twitter-rider-boost", Y = 2026;
const ev = (bike, category, date, partCost, labourCost) =>
  doc.events.push({ id:"t"+doc.events.length, bike, category, date, partCost, labourCost, odo:0 });

/* 12 synthetic events, 2 bikes, 3 categories, plus one in the prior year */
ev(A,"drivetrain",  "2026-01-10", 1000, 200);   // 1200
ev(A,"drivetrain",  "2026-02-10", 1500, 300);   // 1800
ev(A,"drivetrain",  "2026-03-10", 2000,   0);   // 2000   -> 5000
ev(A,"brakes",      "2026-04-10",  800, 400);   // 1200
ev(A,"brakes",      "2026-05-10",  700, 100);   //  800   -> 2000
ev(A,"wheels",      "2026-06-10", 3000, 500);   // 3500   -> 3500
ev(B,"drivetrain",  "2026-01-20",  500, 250);   //  750
ev(B,"drivetrain",  "2026-02-20",  250,   0);   //  250   -> 1000
ev(B,"brakes",      "2026-03-20", 1200, 600);   // 1800
ev(B,"brakes",      "2026-04-20",  200,   0);   //  200   -> 2000
ev(B,"wheels",      "2026-05-20", 1000,1000);   // 2000   -> 2000
ev(A,"drivetrain",  "2025-12-31", 9999,9999);   // prior year — must not count

let n = 0;
const eq = (label, got, want) => { assert.deepStrictEqual(got, want, `${label}: got ${got}, want ${want}`); n++; };

/* --- total per bike per year (hand-computed above) --- */
eq("A year total",    api.yearCost(A, Y), 10500);
eq("B year total",    api.yearCost(B, Y),  5000);
eq("all year total",  api.yearCost(null, Y), 15500);
eq("prior year kept out", api.yearCost(A, 2025), 19998);

/* --- split by category --- */
eq("A drivetrain", api.categorySplit(A, Y).drivetrain, 5000);
eq("A brakes",     api.categorySplit(A, Y).brakes,     2000);
eq("A wheels",     api.categorySplit(A, Y).wheels,     3500);
eq("A suspension unused", api.categorySplit(A, Y).suspension, 0);
eq("all drivetrain", api.categorySplit(null, Y).drivetrain, 6000);
eq("all brakes",     api.categorySplit(null, Y).brakes,     4000);
eq("all wheels",     api.categorySplit(null, Y).wheels,     5500);
{
  const s = api.categorySplit(null, Y);
  eq("split sums to total", Object.values(s).reduce((x,y)=>x+y,0), 15500);
}

/* --- cost per km: null when the odometer is unset, never 0 or Infinity --- */
eq("cost/km unset is null", api.costPerKm(A, Y), null);
doc.odo[A] = 5000;
eq("cost/km computed", api.costPerKm(A, Y), 2.1);
doc.odo[A] = 0;
eq("cost/km zero odo is null", api.costPerKm(A, Y), null);
doc.odo[A] = 5000;

/* --- most expensive line item --- */
{
  const top = api.eventsOf(null, Y).sort((a,b)=>api.evCost(b)-api.evCost(a))[0];
  eq("top line item", api.evCost(top), 3500);
}

/* --- deleted events drop out of every aggregate --- */
doc.events[0].deleted = true;
eq("delete removes from total", api.yearCost(A, Y), 10500 - 1200);
eq("delete removes from split", api.categorySplit(A, Y).drivetrain, 5000 - 1200);
doc.events[0].deleted = false;

/* --- replacement cost defaults to the component's real purchase price --- */
{
  const chain = rules.find(r => r.id === "chain-wear");
  const c = api.matchComponent(A, chain);
  assert.ok(c, "chain rule should match a component on Faraoll");
  eq("part cost comes from the component", api.defaultPartCost(A, chain), c.purchasePrice);
  eq("Faraoll chain price", c.purchasePrice, 3662);
  // a bike with no component list falls back to the rule's own estimate
  eq("fallback to estimate", api.defaultPartCost("speedone-275", chain), chain.est_part_cost);

  // an inspection must never inherit the price of the thing it inspects
  for (const r of rules.filter(r => !r.est_part_cost)) {
    eq("no part cost for " + r.id, api.defaultPartCost(A, r), 0);
    eq("no part cost for " + r.id + " (twitter)", api.defaultPartCost(B, r), 0);
  }
  const headset = rules.find(r => r.id === "headset");
  assert.ok(api.defaultPartCost(A, headset) < 10000,
    "headset service must not be priced at the frameset");
  n++;
}

/* --- forecast is a per-year rate, not a backlog dump --- */
{
  doc.annualKm[B] = 2500; doc.odo[B] = 8000;
  const f = api.forecast(B);
  const total = f.reduce((s, r) => s + r.cost, 0);
  assert.ok(total > 0 && total < 120000,
    `forecast for one bike should be tens of thousands, got ${Math.round(total)}`);
  const clean = f.find(r => r.rule.id === "drivetrain-clean");
  eq("monthly rule fires 12x/year", Math.round(clean.times), 12);
  const chainR = f.find(r => r.rule.id === "chain-wear");   // 2500 km/yr, 2500 km interval
  eq("chain fires once a year", Math.round(chainR.times), 1);
  // raising annual mileage must raise the forecast, and nothing else should
  doc.annualKm[B] = 5000;
  assert.ok(api.forecast(B).find(r => r.rule.id === "chain-wear").times === 2,
    "doubling annual km should double a km-driven rule");
  doc.annualKm[B] = 2500;
  n += 3;
}

/* --- forecast only counts rules that apply to the bike --- */
{
  const f = api.forecast("hagen-teen-pro-20");
  assert.ok(f.length > 0, "kids bike should have applicable rules");
  assert.ok(f.every(r => r.rule.bikes.includes("hagen-teen-pro-20")), "forecast leaked another bike's rules");
  assert.ok(!f.some(r => r.rule.category === "suspension"), "rigid kids bike must not forecast fork service");
  n += 3;
}

/* --- due status needs a prior event, and says so when it has none --- */
{
  const chain = rules.find(r => r.id === "chain-wear");
  eq("no history -> unknown", api.dueStatus("twitter-gravel-v1", chain).state, "unknown");
  doc.odo[A] = 9000;
  doc.events.push({ id:"tx", bike:A, rule:"chain-wear", category:"drivetrain",
                    date:"2026-01-01", odo:1000, partCost:0, labourCost:0 });
  eq("overdue by km", api.dueStatus(A, chain).state, "due");
}

/* --- merge: a wiped device must never blank out the cloud ---
   Regression. A device whose storage Safari evicted boots with empty maps and a
   FRESH mtime, so whole-doc last-writer-wins handed it every field and the
   odometer was erased in the cloud for real. */
{
  const mergeSrc = cut("function mergeDocs(", "async function pull(");
  const mergeDocs = new Function(mergeSrc + "; return mergeDocs;")();

  const cloud = { mtime: 1000, odo:{ "faraoll-g50":1450, "twitter-rider-boost":8000 },
    annualKm:{ "faraoll-g50":4000 }, photos:{ "faraoll-g50":"data:image/jpeg;base64,AAA" },
    events:[{ id:"a1", mtime:1000, bike:"faraoll-g50", partCost:1648, labourCost:600, date:"2026-08-14" }],
    checks:{ "faraoll-g50-checklist-v3": { "рама/руль":1, "рама/седло":1 } }, migratedAt:null };
  const wiped = { mtime: 2000, odo:{}, annualKm:{}, photos:{}, events:[], checks:{},
    migratedAt:"2026-08-14T00:00:00Z" };

  const m = mergeDocs(wiped, cloud);
  eq("odometer survives a wiped device", m.odo["faraoll-g50"], 1450);
  eq("second odometer survives",         m.odo["twitter-rider-boost"], 8000);
  eq("annual km survives",               m.annualKm["faraoll-g50"], 4000);
  eq("photo survives",                   m.photos["faraoll-g50"], "data:image/jpeg;base64,AAA");
  eq("events survive",                   m.events.length, 1);
  eq("checks survive",                   Object.keys(m.checks["faraoll-g50-checklist-v3"]).length, 2);

  // and the reverse: a real newer edit still wins key by key
  const edited = { mtime: 3000, odo:{ "faraoll-g50":1600 }, annualKm:{}, photos:{}, events:[],
    checks:{ "faraoll-g50-checklist-v3": { "рама/руль":0 } }, migratedAt:null };
  const m2 = mergeDocs(edited, cloud);
  eq("newer odometer wins",        m2.odo["faraoll-g50"], 1600);
  eq("untouched odometer kept",    m2.odo["twitter-rider-boost"], 8000);
  eq("uncheck propagates",         m2.checks["faraoll-g50-checklist-v3"]["рама/руль"], 0);
  eq("other tick untouched",       m2.checks["faraoll-g50-checklist-v3"]["рама/седло"], 1);

  // a deletion must not be resurrected by the other side's stale copy
  const deleted = { mtime: 3000, odo:{}, annualKm:{}, photos:{}, checks:{}, migratedAt:null,
    events:[{ id:"a1", mtime:3000, deleted:true, bike:"faraoll-g50", partCost:1648, labourCost:600, date:"2026-08-14" }] };
  eq("tombstone survives merge", mergeDocs(deleted, cloud).events[0].deleted, true);
}

/* --- ownership: sold bikes keep their history but leave the maintenance world --- */
{
  eq("gravel starts sold",      api.ownershipOf("twitter-gravel-v1").state, "sold");
  eq("faraoll starts owned",    api.ownershipOf(A).state, "owned");
  eq("owned list excludes sold", api.ownedBikes().some(b => b.id === "twitter-gravel-v1"), false);
  eq("sold list has it",         api.soldBikes().map(b => b.id), ["twitter-gravel-v1"]);
  eq("no forecast for a sold bike", api.forecast("twitter-gravel-v1").length, 0);
  assert.ok(!api.attention().some(a => a.bike.id === "twitter-gravel-v1"),
    "a sold bike must never appear in the attention list");
  n++;

  // net cost = everything put in, minus what it sold for
  doc.ownership["twitter-gravel-v1"] = { state:"sold", soldPrice:70000, soldDate:"2026-07-01" };
  const spent = api.purchaseTotal("twitter-gravel-v1");
  eq("net cost subtracts the sale", api.netCost("twitter-gravel-v1"), spent - 70000);

  // selling a bike removes it from maintenance without touching its spend history
  doc.events.push({ id:"g1", bike:"twitter-gravel-v1", category:"brakes",
                    date:"2026-03-01", partCost:1000, labourCost:500, odo:0 });
  eq("sold bike keeps its spend", api.yearCost("twitter-gravel-v1", Y), 1500);
  eq("net cost includes that spend", api.netCost("twitter-gravel-v1"), spent + 1500 - 70000);
  eq("still no forecast",         api.forecast("twitter-gravel-v1").length, 0);

  // the synced doc can override the file: a bike can come back
  doc.ownership["twitter-gravel-v1"].state = "owned";
  eq("override brings it back", api.isOwned("twitter-gravel-v1"), true);
  assert.ok(api.forecast("twitter-gravel-v1").length > 0, "an owned bike forecasts again");
  n++;
  doc.ownership["twitter-gravel-v1"].state = "sold";

  // an unpriced sale must not silently read as a 0 ₽ gain
  doc.ownership["speedone-275"] = { state:"sold" };
  eq("unpriced sale keeps full cost", api.netCost("speedone-275"), api.purchaseTotal("speedone-275"));
  eq("unpriced sale has null price",  api.ownershipOf("speedone-275").soldPrice, null);
  delete doc.ownership["speedone-275"];
}

/* --- ownership survives a merge like every other map --- */
{
  const mergeSrc2 = cut("function mergeDocs(", "async function pull(");
  const md = new Function(mergeSrc2 + "; return mergeDocs;")();
  const cloud = { mtime:1000, odo:{}, annualKm:{}, photos:{}, events:[], checks:{},
                  ownership:{ "twitter-gravel-v1":{ state:"sold", soldPrice:70000 } } };
  const wiped = { mtime:2000, odo:{}, annualKm:{}, photos:{}, events:[], checks:{}, ownership:{} };
  eq("sale price survives a wiped device",
     md(wiped, cloud).ownership["twitter-gravel-v1"].soldPrice, 70000);
}

/* --- переименование пункта не теряет поставленную галочку ---
   Устойчивый id — slug(группа)/slug(пункт), поэтому правка текста отвязывает
   галочку. Перенос обязан идти ДО правки текста и быть идемпотентным. */
{
  const renSrc = cut("const RENAMES = {", "/* R4 —");
  const K = "speedone-275-checklist-v1";
  const OLD = "куплено-под-этот-проект/рама-speedone-destroyer-27-5";
  const NEW = "куплено-под-этот-проект/рама-speedone-floater-27-5";

  const mk = checks => {
    const d = { checks };
    const fn = new Function("DOC", "persist", renSrc + "; return applyRenames;")(() => d, () => {});
    return { run: fn, doc: d };
  };

  // галочка стояла на старом названии — должна оказаться на новом
  let t = mk({ [K]: { [OLD]: 1 } });
  eq("перенос сработал", t.run(), 1);
  eq("галочка на новом id", t.doc.checks[K][NEW], 1);
  eq("старый ключ цел (откат)", t.doc.checks[K][OLD], 1);

  // повторный запуск ничего не делает
  eq("идемпотентно", t.run(), 0);

  // снятая галочка (0) переносится именно как снятая, а не как отметка
  t = mk({ [K]: { [OLD]: 0 } });
  t.run();
  eq("ноль переносится нулём", t.doc.checks[K][NEW], 0);

  // если на новом уже что-то есть, старое его не затирает
  t = mk({ [K]: { [OLD]: 1, [NEW]: 0 } });
  eq("новое значение не перетирается", t.run(), 0);
  eq("новое значение сохранено", t.doc.checks[K][NEW], 0);

  // пустой документ переносить нечего
  eq("без чек-листа — тихо", mk({}).run(), 0);

  // новый id действительно совпадает с тем, что теперь в данных
  const slug = s => String(s).toLowerCase().replace(/[^a-zа-яё0-9]+/gi,"-").replace(/^-|-$/g,"").slice(0,48);
  const cl = JSON.parse(fs.readFileSync(__dirname + "/data/checklists.json", "utf8"));
  const found = cl[K].some(g => g.items.some(i => slug(g.g) + "/" + slug(i.n) === NEW));
  assert.ok(found, "новый id должен существовать в данных чек-листа");
  n++;
}

console.log(`ok — ${n} assertions`);
