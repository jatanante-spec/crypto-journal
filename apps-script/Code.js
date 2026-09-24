/**
 * Crypto Scalping Journal — Google Apps Script web app
 *
 * Deploy:
 *  1. In your Google Sheet: Extensions → Apps Script
 *  2. Paste these files (Code.gs, Index, Styles, JavaScript)
 *  3. Deploy → New deployment → Type: Web app
 *     Execute as: Me
 *     Who has access: Anyone
 *  4. Copy the Web app URL
 *
 * Live CoinGecko calls run on Google's servers (UrlFetchApp).
 * Journal state syncs to a hidden sheet named _JournalApp in this
 * spreadsheet so phone and desktop share the same trades.
 */

function doGet() {
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle("Crypto Scalping Journal")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function onOpen() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) {
    PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", ss.getId());
  }
  SpreadsheetApp.getUi()
    .createMenu("Scalping Journal")
    .addItem("Open in sheet", "openJournalDialog")
    .addToUi();
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  } catch (err) {
    ss = null;
  }
  if (ss) {
    props.setProperty("SPREADSHEET_ID", ss.getId());
    return ss;
  }
  const id = props.getProperty("SPREADSHEET_ID");
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (err) {
      throw new Error(
        "Cannot open the journal sync file. In Drive search for 'Crypto Scalping Journal — App Sync' or the Sheet you first opened this from. File → Version history can restore a wiped log. Do not create a second copy."
      );
    }
  }
  ss = SpreadsheetApp.create("Crypto Scalping Journal — App Sync");
  const info = ss.getSheets()[0];
  info.setName("Read me");
  info.getRange("A1").setValue(
    "The web app stores your journal here so phone and desktop stay in sync. Do not delete this file."
  );
  info.getRange("A2").setValue(ss.getUrl());
  props.setProperty("SPREADSHEET_ID", ss.getId());
  return ss;
}

function getJournalSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName("_JournalApp");
  if (!sh) {
    sh = ss.insertSheet("_JournalApp");
    sh.getRange("A1").setValue("CRYPTO_SCALPING_JOURNAL_STATE");
    try {
      sh.hideSheet();
    } catch (err) {
      // Sheets needs at least one visible tab
    }
  }
  return sh;
}

function realTradeCount_(payload) {
  if (!payload || !payload.trades || !payload.trades.length) return 0;
  let n = 0;
  for (let i = 0; i < payload.trades.length; i++) {
    const t = payload.trades[i];
    if (t && t.id !== "example-1") n += 1;
  }
  return n;
}

function tradeExitValue_(t) {
  if (!t) return null;
  if (t.exit == null || t.exit === "") return null;
  const n = Number(t.exit);
  return n > 0 ? n : null;
}

/** Same trade id: never let an open copy replace a closed one (multi-device race). */
function mergeTradesPreferClosed_(existingTrades, incomingTrades) {
  const map = {};
  const order = [];
  function put(t) {
    if (!t || !t.id) return;
    const id = String(t.id);
    if (!map[id]) {
      map[id] = t;
      order.push(id);
      return;
    }
    const cur = map[id];
    const curClosed = tradeExitValue_(cur) != null;
    const nextClosed = tradeExitValue_(t) != null;
    if (curClosed && !nextClosed) return;
    if (!curClosed && nextClosed) {
      map[id] = t;
      return;
    }
    map[id] = t;
  }
  (existingTrades || []).forEach(put);
  (incomingTrades || []).forEach(put);
  return order.map(function (id) {
    return map[id];
  });
}

function mergeDeletedJson_(existingDeleted, incomingDeleted) {
  const out = {};
  const keep = (src) => {
    if (!src || typeof src !== "object" || Array.isArray(src)) return;
    Object.keys(src).forEach(function (id) {
      const k = String(id).slice(0, 80);
      if (!k) return;
      const at = src[id] && src[id].at ? String(src[id].at).slice(0, 40) : "";
      out[k] = { at: at };
    });
  };
  keep(existingDeleted);
  keep(incomingDeleted);
  const ids = Object.keys(out);
  if (ids.length > 500) {
    // Newest 500 only: a tombstone older than that has had every chance to reach every device.
    ids.sort(function (x, y) { return String(out[y].at || "").localeCompare(String(out[x].at || "")); });
    const kept = {};
    ids.slice(0, 500).forEach(function (id) { kept[id] = out[id]; });
    return kept;
  }
  return out;
}

function realTradeIds_(doc) {
  const ids = [];
  if (!doc || !doc.trades) return ids;
  for (let i = 0; i < doc.trades.length; i++) {
    const t = doc.trades[i];
    if (t && t.id && String(t.id) !== "example-1") ids.push(String(t.id));
  }
  return ids;
}

function saveJournalState(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Nothing to save.");
  }
  // SYNC FIX 3: one script lock around the whole read-modify-write, the same idiom syncCoinLibrary uses.
  // Without it two devices interleave their chunk writes and the next read is a torn document.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // SYNC FIX 3: a document that cannot be parsed is refused, never treated as "no journal yet". Only a
    // missing sheet or a missing marker means empty. loadJournalState throws for the parse case.
    const existing = loadJournalState();
    // SYNC FIX 1: tombstones from both sides, applied after the merge so a delete is a fact that travels.
    const deleted = mergeDeletedJson_(existing && existing.deleted, payload.deleted);
    // Count the push BEFORE the merge: the guard protects against a device pushing an empty journal, and the
    // merge would otherwise refill it and hide the very case the guard exists for.
    const incoming = realTradeCount_(payload);
    if (existing && existing.trades && existing.trades.length) {
      payload.trades = mergeTradesPreferClosed_(existing.trades, payload.trades || []);
    }
    payload.trades = (payload.trades || []).filter(function (t) {
      return !t || !t.id || !deleted[String(t.id)];
    });
    payload.deleted = deleted;
    // The guard survives with one change: an empty push the tombstones fully explain is a user deleting their
    // last trade on purpose, which is exactly what used to be impossible.
    const vanishing = realTradeIds_(existing);
    const explained =
      vanishing.length > 0 &&
      vanishing.every(function (id) {
        return !!deleted[id];
      });
    if (realTradeCount_(existing) > 0 && incoming === 0 && !explained) {
      throw new Error(
        "Refused to overwrite your journal with empty sample data. Tap Sync now on the device that still has trades."
      );
    }
    const json = JSON.stringify(payload);
    if (json.length > 200000) {
      throw new Error("Journal is too large to sync. Export JSON and trim old trades.");
    }
    const sh = getJournalSheet_();
    // SYNC FIX 3: marker rows and body in one write, so a reader outside the lock sees a shorter torn window.
    const chunk = 40000;
    const parts = [];
    for (let i = 0; i < json.length; i += chunk) {
      parts.push([json.slice(i, i + chunk)]);
    }
    // Column A holds the marker then the chunks; B1 keeps the timestamp. One rectangle, one write.
    const body = [];
    body.push(["CRYPTO_SCALPING_JOURNAL_STATE", payload.updatedAt || new Date().toISOString()]);
    parts.forEach(function (p) {
      body.push([p[0], ""]);
    });
    const used = Math.max(sh.getLastRow(), body.length);
    if (used > body.length) sh.getRange(body.length + 1, 1, used - body.length, 2).clearContent();
    sh.getRange(1, 1, body.length, 2).setValues(body);
    return { ok: true, updatedAt: payload.updatedAt, bytes: json.length, deleted: Object.keys(deleted).length };
  } finally {
    lock.releaseLock();
  }
}

function loadJournalState() {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName("_JournalApp");
  if (!sh) return null;
  const marker = String(sh.getRange("A1").getValue() || "");
  if (marker !== "CRYPTO_SCALPING_JOURNAL_STATE") return null;
  const last = sh.getLastRow();
  if (last < 2) return null;
  // numRows = last - 1 covers rows 2..last inclusive.
  const parts = sh
    .getRange(2, 1, last - 1, 1)
    .getValues()
    .map(function (row) {
      return row[0];
    })
    .filter(function (cell) {
      return cell !== "" && cell != null;
    });
  if (!parts.length) return null;
  // SYNC FIX 3: a document that exists but will not parse is corruption, not an empty journal. Throwing here is
  // what lets saveJournalState refuse instead of replacing it, and keeps load()'s own catch honest.
  let parsed;
  try {
    parsed = JSON.parse(parts.join(""));
  } catch (err) {
    throw new Error(
      "Saved journal could not be read, so nothing was overwritten. Open the _JournalApp tab and check row 2."
    );
  }
  return parsed;
}

function openJournalDialog() {
  const html = HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setWidth(1100)
    .setHeight(750)
    .setTitle("Crypto Scalping Journal");
  SpreadsheetApp.getUi().showModalDialog(html, "Crypto Scalping Journal");
}

/** Run this from the Apps Script editor to confirm outbound fetch works. */
function probeLiveData() {
  const live = fetchLive("solana", "gbp", "SOL");
  Logger.log(JSON.stringify(live, null, 2));
  return live;
}

/**
 * CoinGecko text search for Find tab (MANA, etc.).
 * Returns [{ ticker, id, name, sample, vs }] — client saves into library / seats.
 */
function searchCoins(query) {
  const q = String(query || "").trim();
  if (q.length < 1) return [];
  const url =
    "https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(q);
  const data = fetchJson_(url);
  const coins = (data && data.coins) || [];
  const out = [];
  const seen = {};
  for (let i = 0; i < coins.length && out.length < 24; i++) {
    const c = coins[i];
    if (!c) continue;
    const ticker = String(c.symbol || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 12);
    const id = String(c.id || "")
      .toLowerCase()
      .trim();
    if (!/^[A-Z0-9]{2,12}$/.test(ticker)) continue;
    if (!/^[a-z0-9-]{2,60}$/.test(id)) continue;
    if (seen[ticker]) continue;
    seen[ticker] = 1;
    out.push({
      ticker: ticker,
      id: id,
      name: String(c.name || ticker),
      sample: 1,
      vs: "gbp",
      core: false,
      marketCapRank: c.market_cap_rank == null ? null : Number(c.market_cap_rank),
    });
  }
  return out;
}

/**
 * Light Scout peek: market + closes + hourly (no ATR). Writes into a book
 * without switching the active seat. Prefer this over full fetchLive for glance.
 */
function peekLive(coinId, vs, ticker) {
  const market = fetchMarket(coinId, vs, ticker);
  market.hourTrendSupport = null;
  market.hourlyFeed = null;
  market.hourlyOhlc = [];
  let closes = [];
  let hourly = [];
  let hourlyVolumes = [];
  let hourlyAts = [];
  let atrHourly = 0;
  try {
    closes = fetchDailyCloses(coinId, vs, ticker);
  } catch (err) {
    Logger.log("peek closes failed: " + err);
  }
  try {
    const hourPack = fetchHourlyPack(coinId, vs, ticker);
    hourly = hourPack.closes || [];
    hourlyVolumes = hourPack.volumes || [];
    hourlyAts = hourPack.ats || [];
    atrHourly = hourPack.atrHourly || 0;
    market.hourTrendSupport = hourPack.trendSupport || null;
    market.hourlyFeed = hourPack.feed || null;
    market.hourlyOhlc = (hourPack.ohlc || []).slice(-168);
  } catch (err) {
    Logger.log("peek hourly failed: " + err);
  }
  return {
    market: market,
    closes: closes,
    hourly: hourly,
    hourlyVolumes: hourlyVolumes,
    hourlyAts: hourlyAts,
    atrHourly: atrHourly,
    atrDataVersion: 2,
    source: (market && market.source) || "Peek",
    peek: true,
  };
}

function fetchLive(coinId, vs, ticker) {
  const market = fetchMarket(coinId, vs, ticker);
  market.hourTrendSupport = null;
  market.hourlyFeed = null;
  market.hourlyOhlc = [];
  let closes = [];
  let hourly = [];
  let hourlyVolumes = [];
  let hourlyAts = [];
  let atr14 = 0;
  let atrHourly = 0;
  try {
    closes = fetchDailyCloses(coinId, vs, ticker);
  } catch (err) {
    Logger.log("closes failed after market ok: " + err);
  }
  try {
    atr14 = fetchAtr(coinId, vs, ticker);
  } catch (err) {
    Logger.log("ATR failed: " + err);
  }
  try {
    const hourPack = fetchHourlyPack(coinId, vs, ticker);
    hourly = hourPack.closes || [];
    hourlyVolumes = hourPack.volumes || [];
    hourlyAts = hourPack.ats || [];
    atrHourly = hourPack.atrHourly || 0;
    market.hourTrendSupport = hourPack.trendSupport || null;
    market.hourlyFeed = hourPack.feed || null;
    market.hourlyOhlc = (hourPack.ohlc || []).slice(-168);
  } catch (err) {
    Logger.log("hourly failed: " + err);
  }
  return {
    market: market,
    closes: closes,
    hourly: hourly,
    hourlyVolumes: hourlyVolumes,
    hourlyAts: hourlyAts,
    atr14: atr14,
    atrHourly: atrHourly,
    atrDataVersion: 2,
    source: market.source || "CoinGecko",
  };
}

function fetchHourlyCloses(coinId, vs, ticker) {
  return fetchHourlyPack(coinId, vs, ticker).closes;
}

// BP1: genuine candles first; price-only fallback explicitly remains unsuitable for ATR.
function bpFeedReason_(err) {
  const s=String(err&&err.message||err||'');
  if(/429|rate limit|Too many requests/i.test(s))return 'Provider rate limit; try later.';
  if(/401|403|Forbidden|Unauthorized/i.test(s))return 'Provider refused access.';
  if(/currency|symbol|identity|pair|mapping/i.test(s))return 'Coin/currency pair unsupported or identity validation failed.';
  if(/stale|consecutive|completed|future|candle|ATR|OHLC|invalid/i.test(s))return 'Candle data incomplete, stale, invalid or insufficient for ATR.';
  if(/timeout|timed out/i.test(s))return 'Provider request timed out.';
  return 'Provider request failed or returned no usable data.';
}
function fetchHourlyPack(coinId, vs, ticker) {
  const id=String(coinId||'solana'),cur=String(vs||'gbp').toLowerCase(),symbol=String(ticker||'SOL').toUpperCase(),attempts=[];
  function attach(p,source,status,note){
    p.feed={fx:p.fx||null,version:1,coinId:id,ticker:symbol,currency:cur,source:source,status:status,barAt:p.ats&&p.ats.length?p.ats[p.ats.length-1]:null,count:(p.closes||[]).length,retrievedAt:new Date().toISOString(),attempts:attempts.slice(),note:note};return p;
  }
  try {
    bpKrakenAsset_(id,symbol); // Shared canonical ID/ticker allowlist before either candle provider.
    const p=fetchHourlyFromYahoo_(symbol,cur);
    if(!(p.atrHourly>0&&isFinite(p.atrHourly)))throw new Error('Hourly ATR invalid');
    attempts.push({source:'Yahoo',status:'READY'});
    return attach(p,'Yahoo hourly OHLC (GBP may use USD conversion)','READY','Candles and ATR come from the same hourly series. Quote/range can use a different provider. Yahoo GBP fallback may scale USD candles using its cached GBPUSD rate, not historical hourly FX.');
  }catch(e){attempts.push({source:'Yahoo',status:'FAILED',reason:bpFeedReason_(e)});}
  try {
    const p=fetchHourlyFromKraken_(id,cur,symbol);
    attempts.push({source:'Kraken',status:'READY'});
    return attach(p,'Kraken '+p.pair+' hourly OHLC','READY',p.fx?'USD exchange candles converted to GBP using one completed GBP/USD candle close at '+p.fx.at+'. This is not historical hourly FX adjustment or a native GBP market. Quote/range providers may differ.':'Native quote-currency exchange candles; no FX conversion. Candle and quote/range providers may differ.');
  }catch(e){attempts.push({source:'Kraken',status:'FAILED',reason:bpFeedReason_(e)});}
  try {
    const p=fetchHourlyFromCoinGecko_(id,cur);
    attempts.push({source:'CoinGecko',status:'PRICE_ONLY'});
    return attach(p,'CoinGecko hourly price observations','PRICE_ONLY','Chart prices refreshed, but genuine hourly candles were unavailable. No hourly ATR or stop/target proposal is invented.');
  }catch(e){attempts.push({source:'CoinGecko',status:'FAILED',reason:bpFeedReason_(e)});}
  return attach({closes:[],volumes:[],ats:[],atrHourly:0,trendSupport:null},'No usable hourly feed','UNAVAILABLE','Quote may have refreshed; hourly evidence did not. Inspect the attempts above.');
}
function bpKrakenAsset_(coinId,ticker){
  // Explicit canonical CoinGecko ID + ticker mapping: never guess from a shared ticker alone.
  const map={bitcoin:['BTC','XBT'],ethereum:['ETH','ETH'],solana:['SOL','SOL'],cardano:['ADA','ADA'],uniswap:['UNI','UNI'],ripple:['XRP','XRP'],dogecoin:['DOGE','XDG'],polkadot:['DOT','DOT'],chainlink:['LINK','LINK'],litecoin:['LTC','LTC'],'avalanche-2':['AVAX','AVAX'],cosmos:['ATOM','ATOM'],stellar:['XLM','XLM'],aave:['AAVE','AAVE'],aptos:['APT','APT'],'near':['NEAR','NEAR'],'bitcoin-cash':['BCH','BCH'],'ethereum-classic':['ETC','ETC'],algorand:['ALGO','ALGO'],filecoin:['FIL','FIL'],decentraland:['MANA','MANA'],'the-sandbox':['SAND','SAND'],optimism:['OP','OP'],arbitrum:['ARB','ARB'],sui:['SUI','SUI'],'matic-network':['MATIC','MATIC'],'injective-protocol':['INJ','INJ'],'fetch-ai':['FET','FET'],'render-token':['RENDER','RENDER'],'the-open-network':['TON','TON'],'sei-network':['SEI','SEI'],'immutable-x':['IMX','IMX'],'the-graph':['GRT','GRT'],'hedera-hashgraph':['HBAR','HBAR'],vechain:['VET','VET'],pepe:['PEPE','PEPE'],'shiba-inu':['SHIB','SHIB'],dogwifcoin:['WIF','WIF'],bonk:['BONK','BONK']};
  const pair=map[coinId];if(!pair||pair[0]!==ticker)throw new Error('No verified Kraken coin identity mapping');return pair[1];
}
function fetchHourlyFromKraken_(coinId,currency,ticker){
  if(!/^(gbp|usd|eur)$/.test(currency))throw new Error('Unsupported Kraken currency');
  const asset=bpKrakenAsset_(coinId,ticker),quote=currency.toUpperCase();
  try{return bpKrakenNative_(asset,quote);}catch(e){
    if(currency!=='gbp'||isRateLimitErr_(e))throw e;
    const usd=bpKrakenNative_(asset,'USD');
    const cache=CacheService.getScriptCache();let fx=null;
    try{fx=JSON.parse(cache.get('bp1_kraken_gbpusd_fx')||'null');}catch(ignore){}
    if(!fx||!(fx.rate>0)||!isFinite(fx.rate)||!isFinite(Date.parse(fx.at))||Date.now()-Date.parse(fx.at)>3*3600000||Date.parse(fx.at)>Date.now()){
      const fp=bpKrakenNative_('GBP','USD');fx={rate:fp.closes[fp.closes.length-1],at:fp.ats[fp.ats.length-1],source:'Kraken GBP/USD completed hourly close'};
      try{cache.put('bp1_kraken_gbpusd_fx',JSON.stringify(fx),600);}catch(ignore){}
    }
    if(!(fx.rate>0&&isFinite(fx.rate))||!isFinite(Date.parse(fx.at))||Date.now()-Date.parse(fx.at)>3*3600000)throw new Error('Stale or invalid FX candle');
    usd.closes=usd.closes.map(function(v){return v/fx.rate;});usd.atrHourly/=fx.rate;usd.ohlc=(usd.ohlc||[]).map(function(r){return [r[0],r[1]/fx.rate,r[2]/fx.rate,r[3]/fx.rate,r[4]/fx.rate];});usd.fx=fx;usd.pair=asset+'/USD converted to GBP';return usd;
  }
}
function bpKrakenNative_(asset,quote){
  const wanted=asset+'/'+quote,query=asset+quote;
  const cache=CacheService.getScriptCache(),cacheKey='bp1_pair_'+query;
  let pair=null,cached=cache.get(cacheKey);
  if(cached){try{pair=JSON.parse(cached);}catch(e){}}
  if(!pair){
    const data=fetchJson_('https://api.kraken.com/0/public/AssetPairs?pair='+encodeURIComponent(query));
    if(data.error&&data.error.length)throw new Error(/rate limit/i.test(data.error.join(' '))?'Kraken rate limit':'Kraken pair unavailable');
    const results=data.result||{},keys=Object.keys(results).filter(function(k){const p=results[k];return p.wsname===wanted&&p.status==='online';});
    if(keys.length!==1)throw new Error('Kraken pair identity mismatch');
    const found=results[keys[0]];pair={key:keys[0],altname:found.altname,wsname:found.wsname};
    try{cache.put(cacheKey,JSON.stringify(pair),3600);}catch(e){}
  }
  if(pair.wsname!==wanted||!pair.key||!pair.altname)throw new Error('Cached pair identity mismatch');
  const data=fetchJson_('https://api.kraken.com/0/public/OHLC?pair='+encodeURIComponent(pair.altname)+'&interval=60');
  if(data.error&&data.error.length)throw new Error(/rate limit/i.test(data.error.join(' '))?'Kraken rate limit':'Kraken OHLC unavailable');
  const result=data.result||{},keys=Object.keys(result).filter(function(k){return k!=='last';});
  if(keys.length!==1||keys[0]!==pair.key)throw new Error('Kraken OHLC pair identity mismatch');
  const p=bpKrakenPack_(result[keys[0]]);p.pair=wanted;return p;
}
function bpKrakenPack_(rows){
  if(!Array.isArray(rows)||rows.length<16)throw new Error('Insufficient hourly candles');
  const cutoff=Math.floor(Date.now()/3600000)*3600000,pack={closes:[],volumes:[],ats:[],bars:[]};
  // Kraken's final row is an uncommitted candle: always exclude it as well as the current hour.
  rows.slice(0,-1).forEach(function(r){
    if(!Array.isArray(r)||r.length<8)throw new Error('Invalid candle row');
    const ts=Number(r[0])*1000,o=Number(r[1]),h=Number(r[2]),l=Number(r[3]),c=Number(r[4]),vol=Number(r[6]);
    if(!isFinite(ts)||ts%3600000!==0)throw new Error('Invalid candle time');
    if(ts>cutoff)throw new Error('Future candle');if(ts===cutoff)return;
    if([r[1],r[2],r[3],r[4]].some(function(v){return v==null||v==='';})||![o,h,l,c].every(function(v){return v>0&&isFinite(v);})||h<l||o>h||o<l||c>h||c<l)throw new Error('Invalid OHLC candle');
    if(pack.ats.length&&ts<=Date.parse(pack.ats[pack.ats.length-1]))throw new Error('Invalid candle ordering');
    pack.closes.push(c);pack.volumes.push(r[6]!=null&&r[6]!==''&&vol>=0&&isFinite(vol)?vol:null);pack.ats.push(new Date(ts).toISOString());pack.bars.push({o:o,h:h,l:l,c:c});
  });
  const tail=validatedHourlyTail_(pack),atr=atrFromBars_(tail.bars);
  if(!(atr>0&&isFinite(atr)))throw new Error('Invalid hourly ATR');
  const support=hourlyAdx_(tail.bars,tail.ats[tail.ats.length-1]);if(support)support.source='Kraken 60m OHLC';
  return {closes:tail.closes,volumes:tail.volumes,ats:tail.ats,ohlc:tail.bars.map(function(b,i){return [tail.ats[i],b.o,b.h,b.l,b.c];}),atrHourly:atr,trendSupport:support};
}

/** Keep a recent contiguous tail; never manufacture missing hours. */
function validatedHourlyTail_(pack) {
  const ats = pack.ats || [];
  let start = 0;
  for (let i = 1; i < ats.length; i++) {
    if (Date.parse(ats[i]) - Date.parse(ats[i - 1]) !== 3600000) start = i;
  }
  if (ats.length - start < 15) throw new Error("Need 15 consecutive completed hourly observations.");
  const last = Date.parse(ats[ats.length - 1]);
  if (!isFinite(last) || Date.now() - last > 3 * 3600000) throw new Error("Hourly data is stale.");
  start = Math.max(start, ats.length - HOURLY_KEEP_);
  return { closes: pack.closes.slice(start), volumes: pack.volumes.slice(start), ats: ats.slice(start), bars: pack.bars ? pack.bars.slice(start) : [] };
}

/** Bucket CG price/volume rows into true 1h bars (ts in ms). */
function bucketHourlySeries_(prices, volumes) {
  const byHour = {};
  const cutoff = Math.floor(Date.now() / 3600000) * 3600000;
  (prices || []).slice().sort(function(a,b) { return a[0]-b[0]; }).forEach(function(row) {
    const ts = Number(row[0]), px = Number(row[1]);
    if (!isFinite(ts) || !(px > 0) || !isFinite(px)) return;
    const hour = Math.floor(ts / 3600000) * 3600000;
    if (hour >= cutoff) return;
    byHour[hour] = px;
  });
  const hours = Object.keys(byHour).map(Number).sort(function(a,b) { return a-b; });
  // market_chart total_volumes are rolling 24h snapshots, NOT bar volume.
  return { closes: hours.map(function(h) { return byHour[h]; }),
    volumes: hours.map(function() { return null; }),
    ats: hours.map(function(h) { return new Date(h).toISOString(); }) };
}

function atrFromCloseSeries_(closes) {
  const moves = [];
  for (let i = 1; i < closes.length; i++) {
    const a = Number(closes[i]);
    const b = Number(closes[i - 1]);
    if (!(a > 0) || !(b > 0)) continue;
    moves.push(Math.abs(a - b));
  }
  const window = moves.slice(-14);
  if (window.length < 7) return 0;
  const sum = window.reduce(function (x, y) {
    return x + y;
  }, 0);
  return sum / window.length;
}

/** Keep ~7d of hourly bars for swing lows/highs (Market map + Dip zones). */
var HOURLY_KEEP_ = 168;

function fetchHourlyFromCoinGecko_(id, currency) {
  const base = "https://api.coingecko.com/api/v3/coins/" + encodeURIComponent(id) +
    "/market_chart?vs_currency=" + encodeURIComponent(currency) + "&days=7";
  let data;
  try { data = fetchJson_(base + "&interval=hourly"); }
  catch (err) { if (isRateLimitErr_(err)) throw err; data = fetchJson_(base); }
  const pack = validatedHourlyTail_(bucketHourlySeries_(data.prices || [], []));
  // Hourly price observations can support RSI, but are not OHLC candles.
  return { closes: pack.closes, volumes: pack.volumes, ats: pack.ats, atrHourly: 0 };
}

function fetchHourlyFromYahoo_(ticker, currency) {
  const chart = yahooChart_(ticker, currency, "60m", "7d");
  const raw = chart.indicators && chart.indicators.quote && chart.indicators.quote[0];
  if (!raw) throw new Error("Yahoo hourly had no quote.");
  const pack = { closes: [], volumes: [], ats: [], bars: [] };
  const cutoff = Math.floor(Date.now() / 3600000) * 3600000;
  (chart.timestamp || []).forEach(function(sec, i) {
    const ts = Number(sec) * 1000;
    const c = raw.close && raw.close[i], h = raw.high && raw.high[i], l = raw.low && raw.low[i];
    if (!(ts > 0) || ts % 3600000 !== 0 || ts >= cutoff) return;
    if (![c,h,l].every(function(v) { return v != null && isFinite(Number(v)) && Number(v) > 0; })) return;
    if (Number(h) < Number(l) || Number(c) > Number(h) || Number(c) < Number(l)) return;
    const v = raw.volume && raw.volume[i];
    pack.closes.push(Number(c));
    pack.volumes.push(v != null && isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
    pack.ats.push(new Date(ts).toISOString());
    pack.bars.push({o:raw.open&&raw.open[i]!=null?Number(raw.open[i]):null,h:Number(h), l:Number(l), c:Number(c)});
  });
  const tail = validatedHourlyTail_(pack);
  return {closes:tail.closes, volumes:tail.volumes, ats:tail.ats, ohlc:tail.bars.map(function(b,i){return [tail.ats[i],b.o,b.h,b.l,b.c];}),atrHourly:atrFromBars_(tail.bars),trendSupport:hourlyAdx_(tail.bars,tail.ats[tail.ats.length-1])};
}

function fetchAtr(coinId, vs, ticker) {
  const id = String(coinId || "solana");
  const currency = String(vs || "gbp").toLowerCase();
  const symbol = String(ticker || "SOL").toUpperCase();
  const errors = [];
  try {
    return fetchAtrFromCoinGecko_(id, currency);
  } catch (err) {
    errors.push(err.message);
  }
  try {
    return fetchAtrFromYahoo_(symbol, currency);
  } catch (err) {
    errors.push(err.message);
  }
  throw new Error("ATR fetch failed. " + errors.join(" | "));
}

function atrFromBars_(bars) {
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const high = Number(bars[i].h);
    const low = Number(bars[i].l);
    const prev = Number(bars[i - 1].c);
    if (!isFinite(high) || !isFinite(low) || !isFinite(prev)) continue;
    trs.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  const window = trs.slice(-14);
  if (window.length < 14) throw new Error("Need 15 bars for ATR(14).");
  const sum = window.reduce(function (a, b) {
    return a + b;
  }, 0);
  return sum / window.length;
}

function fetchAtrFromCoinGecko_(id, currency) {
  const rows = fetchJson_("https://api.coingecko.com/api/v3/coins/" + encodeURIComponent(id) +
    "/ohlc?vs_currency=" + encodeURIComponent(currency) + "&days=30");
  // This endpoint returns 4h candles, timestamped at CLOSE. Aggregate six
  // consecutive completed candles into each UTC day before calculating ATR.
  const days = {};
  (rows || []).slice().sort(function(a,b) { return a[0]-b[0]; }).forEach(function(r) {
    const ts = Number(r[0]);
    if (!(ts > 0) || ts > Date.now() || ts % 14400000 !== 0) return;
    if (![r[2],r[3],r[4]].every(function(v) { return v != null && isFinite(Number(v)) && Number(v)>0; })) return;
    const day = Math.floor((ts - 1) / 86400000) * 86400000;
    if (!days[day]) days[day] = {};
    days[day][ts] = {h:Number(r[2]),l:Number(r[3]),c:Number(r[4])};
  });
  let bars = [], previous = null;
  Object.keys(days).map(Number).sort(function(a,b) {return a-b;}).forEach(function(day) {
    const parts = days[day], stamps = Object.keys(parts).map(Number).sort(function(a,b) {return a-b;});
    if (stamps.length !== 6 || stamps.some(function(ts,i) {return ts !== day+(i+1)*14400000;})) return;
    if (previous != null && day-previous !== 86400000) bars=[];
    bars.push({h:Math.max.apply(null, stamps.map(function(t){return parts[t].h;})),
      l:Math.min.apply(null, stamps.map(function(t){return parts[t].l;})), c:parts[stamps[5]].c});
    previous=day;
  });
  if (previous == null || Date.now()-(previous+86400000)>2*86400000) throw new Error("Daily OHLC stale.");
  return atrFromBars_(bars);
}

function fetchAtrFromYahoo_(ticker, currency) {
  const chart = yahooChart_(ticker, currency);
  const raw = chart.indicators && chart.indicators.quote && chart.indicators.quote[0];
  if (!raw) throw new Error("Yahoo had no OHLC for ATR.");
  const bars = [];
  const n = (raw.close || []).length;
  for (let i = 0; i < n; i++) {
    if (!chart.timestamp || Number(chart.timestamp[i]) * 1000 >= Math.floor(Date.now()/86400000)*86400000) continue;
    if (raw.high[i] == null || raw.low[i] == null || raw.close[i] == null) continue;
    bars.push({ h: raw.high[i], l: raw.low[i], c: raw.close[i] });
  }
  return atrFromBars_(bars);
}

function fetchMarket(coinId, vs, ticker) {
  const id = String(coinId || "solana");
  const currency = String(vs || "gbp").toLowerCase();
  const symbol = String(ticker || "SOL").toUpperCase();
  const errors = [];
  try {
    return fetchMarketFromCoinGeckoMarkets_(id, currency);
  } catch (err) {
    errors.push(err.message);
    // On 429, skip the second CoinGecko call — same quota, burns the fallback.
    if (!isRateLimitErr_(err)) {
      try {
        return fetchMarketFromCoinGeckoCoin_(id, currency);
      } catch (err2) {
        errors.push(err2.message);
      }
    }
  }
  try {
    return fetchMarketFromYahoo_(symbol, currency);
  } catch (err) {
    errors.push(err.message);
  }
  throw new Error("Live fetch failed. " + errors.join(" | "));
}

function fetchDailyCloses(coinId, vs, ticker) {
  const id = String(coinId || "solana");
  const currency = String(vs || "gbp").toLowerCase();
  const symbol = String(ticker || "SOL").toUpperCase();
  const errors = [];
  try {
    return fetchClosesFromCoinGecko_(id, currency);
  } catch (err) {
    errors.push(err.message);
  }
  try {
    return fetchClosesFromYahoo_(symbol, currency).slice(-60);
  } catch (err) {
    errors.push(err.message);
  }
  throw new Error("Closes fetch failed. " + errors.join(" | "));
}

function fetchMarketFromCoinGeckoMarkets_(id, currency) {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=" +
    encodeURIComponent(currency) +
    "&ids=" +
    encodeURIComponent(id) +
    "&price_change_percentage=24h,7d,14d,30d";
  const rows = fetchJson_(url);
  const row = rows && rows[0];
  if (!row || row.current_price == null) {
    throw new Error("CoinGecko markets had no " + id + "/" + currency + " row.");
  }
  return {
    price: Number(row.current_price),
    high24h: Number(row.high_24h),
    low24h: Number(row.low_24h),
    change24h: n_(row.price_change_percentage_24h_in_currency || row.price_change_percentage_24h, 4),
    change7d: n_(row.price_change_percentage_7d_in_currency, 4),
    change14d: n_(row.price_change_percentage_14d_in_currency, 4),
    change30d: n_(row.price_change_percentage_30d_in_currency, 4),
    source: "CoinGecko",
  };
}

function fetchMarketFromCoinGeckoCoin_(id, currency) {
  const url =
    "https://api.coingecko.com/api/v3/coins/" +
    encodeURIComponent(id) +
    "?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false";
  const data = fetchJson_(url);
  const md = data.market_data;
  if (!md) throw new Error("CoinGecko coin had no market_data.");
  const price = md.current_price && md.current_price[currency];
  const high24h = md.high_24h && md.high_24h[currency];
  const low24h = md.low_24h && md.low_24h[currency];
  if (price == null || high24h == null || low24h == null) {
    throw new Error("No " + currency.toUpperCase() + " prices for " + id + ".");
  }
  return {
    price: Number(price),
    high24h: Number(high24h),
    low24h: Number(low24h),
    change24h: n_(md.price_change_percentage_24h || 0, 4),
    change7d: n_(md.price_change_percentage_7d || 0, 4),
    change14d: n_(md.price_change_percentage_14d || 0, 4),
    change30d: n_(md.price_change_percentage_30d || 0, 4),
    source: "CoinGecko",
  };
}

function fetchClosesFromCoinGecko_(id, currency) {
  const url =
    "https://api.coingecko.com/api/v3/coins/" +
    encodeURIComponent(id) +
    "/market_chart?vs_currency=" +
    encodeURIComponent(currency) +
    "&days=365";
  const data = fetchJson_(url);
  const prices = data.prices || [];
  if (!prices.length) throw new Error("CoinGecko market_chart returned no prices.");
  return prices.map(function (row) {
    return Number(row[1]);
  }).slice(-60);
}

function fetchMarketFromYahoo_(ticker, currency) {
  const pack = yahooChartPack_(ticker, currency, "1d", "3mo");
  const chart = pack.chart;
  const closes = yahooClosesFromChart_(chart);
  if (closes.length < 2) {
    throw new Error("Yahoo returned too few closes for " + ticker + "-" + String(currency).toUpperCase() + ".");
  }
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] || last;
  const meta = chart.meta || {};
  const high = meta.regularMarketDayHigh != null ? meta.regularMarketDayHigh : last;
  const low = meta.regularMarketDayLow != null ? meta.regularMarketDayLow : last;
  const src = pack.viaUsd ? "Yahoo · USD→GBP" : "Yahoo";
  return {
    price: Number(meta.regularMarketPrice != null ? meta.regularMarketPrice : last),
    high24h: Number(high),
    low24h: Number(low),
    change24h: n_(pctChange_(last, prev), 4),
    change7d: n_(pctChange_(last, closes[closes.length - 8] || closes[0]), 4),
    change14d: n_(pctChange_(last, closes[closes.length - 15] || closes[0]), 4),
    change30d: n_(pctChange_(last, closes[closes.length - 31] || closes[0]), 4),
    source: src,
  };
}

function fetchClosesFromYahoo_(ticker, currency) {
  const pack = yahooChartPack_(ticker, currency, "1d", "3mo");
  const closes = yahooClosesFromChart_(pack.chart);
  if (closes.length < 2) {
    throw new Error("Yahoo returned too few closes for " + ticker + "-" + String(currency).toUpperCase() + ".");
  }
  return closes;
}

function yahooClosesFromChart_(chart) {
  const raw = chart.indicators && chart.indicators.quote && chart.indicators.quote[0];
  return ((raw && raw.close) || [])
    .filter(function (p) {
      return p != null && !isNaN(Number(p));
    })
    .map(function (p) {
      return Number(p);
    });
}

/**
 * Yahoo crypto: try TICKER-GBP first; many alts only list TICKER-USD.
 * Convert USD → GBP via GBPUSD=X (USD per 1 GBP).
 */
function yahooChart_(ticker, currency, interval, range) {
  return yahooChartPack_(ticker, currency, interval, range).chart;
}

function yahooChartPack_(ticker, currency, interval, range) {
  const cur = String(currency || "gbp").toUpperCase();
  const sym = String(ticker || "SOL").toUpperCase();
  const errors = [];
  try {
    return {
      chart: yahooChartSymbol_(sym + "-" + cur, interval, range),
      viaUsd: false,
    };
  } catch (err) {
    errors.push(err.message);
  }
  if (cur === "GBP") {
    try {
      const usdChart = yahooChartSymbol_(sym + "-USD", interval, range);
      let mult = 1;
      if (cur === "GBP") {
        const usdPerGbp = yahooUsdPerGbp_();
        if (!(usdPerGbp > 0)) throw new Error("No GBPUSD FX rate.");
        mult = 1 / usdPerGbp;
      }
      return {
        chart: scaleYahooChart_(usdChart, mult),
        viaUsd: true,
      };
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(
    "Yahoo had no chart for " +
      sym +
      "-" +
      cur +
      (errors.length ? " (" + errors.join(" | ") + ")" : "") +
      "."
  );
}

function yahooChartSymbol_(yahooSymbol, interval, range) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSymbol) +
    "?interval=" +
    encodeURIComponent(interval || "1d") +
    "&range=" +
    encodeURIComponent(range || "3mo");
  const data = fetchJson_(url);
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error("Yahoo empty result for " + yahooSymbol + ".");
  if(String(result.meta && result.meta.symbol || "").toUpperCase() !== String(yahooSymbol).toUpperCase())throw new Error("Yahoo symbol mismatch");
  if(yahooSymbol.indexOf("-")>=0 && String(result.meta && result.meta.currency || "").toUpperCase()!==String(yahooSymbol).split("-").pop().toUpperCase())throw new Error("Yahoo currency mismatch");
  const err = data.chart && data.chart.error;
  if (err && err.description) throw new Error("Yahoo " + yahooSymbol + ": " + err.description);
  return result;
}

/** USD per 1 GBP from Yahoo GBPUSD=X. Cached ~1h. */
function yahooUsdPerGbp_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get("fx_usd_per_gbp");
  if (hit && Number(hit) > 0) return Number(hit);
  const chart = yahooChartSymbol_("GBPUSD=X", "1d", "5d");
  const meta = chart.meta || {};
  let rate = Number(meta.regularMarketPrice);
  if (!(rate > 0)) {
    const closes = yahooClosesFromChart_(chart);
    rate = closes.length ? Number(closes[closes.length - 1]) : 0;
  }
  if (!(rate > 0)) throw new Error("Yahoo GBPUSD=X had no rate.");
  cache.put("fx_usd_per_gbp", String(rate), 3600);
  return rate;
}

function scaleYahooChart_(chart, mult) {
  if (!(mult > 0) || mult === 1) return chart;
  const out = JSON.parse(JSON.stringify(chart));
  const meta = out.meta || {};
  [
    "regularMarketPrice",
    "regularMarketDayHigh",
    "regularMarketDayLow",
    "chartPreviousClose",
    "previousClose",
  ].forEach(function (k) {
    if (meta[k] != null && !isNaN(Number(meta[k]))) meta[k] = Number(meta[k]) * mult;
  });
  out.meta = meta;
  const quote = out.indicators && out.indicators.quote && out.indicators.quote[0];
  if (quote) {
    ["open", "high", "low", "close"].forEach(function (k) {
      if (!quote[k]) return;
      quote[k] = quote[k].map(function (v) {
        return v == null || isNaN(Number(v)) ? v : Number(v) * mult;
      });
    });
  }
  return out;
}

function isRateLimitErr_(err) {
  const msg = String((err && err.message) || err || "");
  return msg.indexOf("429") >= 0 || /rate limit/i.test(msg);
}

function fetchJson_(url) {
  const headers = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; CryptoScalpingJournal/1.0)",
  };
  const demoKey = PropertiesService.getScriptProperties().getProperty("COINGECKO_DEMO_KEY");
  if (demoKey && url.indexOf("coingecko.com") !== -1) {
    headers["x-cg-demo-api-key"] = demoKey;
  }
  const options = { muteHttpExceptions: true, followRedirects: true, headers: headers };
  let res = UrlFetchApp.fetch(url, options);
  let code = res.getResponseCode();
  // Free CoinGecko is strict — back off harder before Yahoo fallback.
  if (code === 429) {
    Utilities.sleep(2500);
    res = UrlFetchApp.fetch(url, options);
    code = res.getResponseCode();
  }
  if (code === 429) {
    Utilities.sleep(4000);
    res = UrlFetchApp.fetch(url, options);
    code = res.getResponseCode();
  }
  const text = res.getContentText();
  if (code !== 200) {
    const host = url.split("/")[2] || "source";
    const snippet = String(text || "").replace(/\s+/g, " ").slice(0, 160);
    throw new Error(host + " " + code + (snippet ? " — " + snippet : ""));
  }
  return JSON.parse(text);
}

function n_(value, digits) {
  const factor = Math.pow(10, digits == null ? 4 : digits);
  return Math.round(Number(value) * factor) / factor;
}

function pctChange_(now, then) {
  if (!then) return 0;
  return ((Number(now) - Number(then)) / Number(then)) * 100;
}

/** Wilder ADX/DMI(14), only from completed contiguous validated OHLC. */
function hourlyAdx_(bars, at) {
  const period=14;
  if (!bars || bars.length < 42 || !at) return null; // extra warm-up beyond first ADX
  let tr=0,plus=0,minus=0,dxs=[],adx=null,pdi=0,mdi=0;
  for(let i=1;i<bars.length;i++) {
    const b=bars[i],a=bars[i-1];
    if (![b.h,b.l,b.c,a.h,a.l,a.c].every(function(v){return v!=null && isFinite(Number(v)) && Number(v)>0;})) return null;
    const range=Math.max(b.h-b.l,Math.abs(b.h-a.c),Math.abs(b.l-a.c));
    const up=b.h-a.h,down=a.l-b.l,p=up>down&&up>0?up:0,m=down>up&&down>0?down:0;
    if(i<=period){tr+=range;plus+=p;minus+=m;}else{tr=tr-tr/period+range;plus=plus-plus/period+p;minus=minus-minus/period+m;}
    if(i>=period){
      pdi=tr>0?100*plus/tr:0;mdi=tr>0?100*minus/tr:0;
      const dx=pdi+mdi>0?100*Math.abs(pdi-mdi)/(pdi+mdi):0;
      if(adx==null){dxs.push(dx);if(dxs.length===period)adx=dxs.reduce(function(a,b){return a+b;},0)/period;}
      else adx=(adx*(period-1)+dx)/period;
    }
  }
  return adx==null?null:{version:1,adx:adx,plus:pdi,minus:mdi,at:at,source:'Yahoo 60m OHLC',period:14,smoothing:'Wilder'};
}

/** Independent coin preferences; never reads/writes trade rows during normal sync. */
function syncCoinLibrary(request) {
  const lock=LockService.getScriptLock();lock.waitLock(20000);
  try {
    request=request||{};
    const ss=getSpreadsheet_();let sh=ss.getSheetByName('_CoinLibrary');
    let doc={version:1,revision:0,coins:{},seen:[]};
    if(sh&&sh.getLastRow()>=2){
      const text=sh.getRange(2,1,sh.getLastRow()-1,1).getValues().map(function(r){return r[0]||'';}).join('');
      if(text)doc=JSON.parse(text); // Corruption must fail, never replace with an empty document.
    }
    let changed=!sh;
    function putMeta(op,seed){
      const t=String(op.ticker||'').toUpperCase(),id=String(op.id||'').toLowerCase();
      if(!/^[A-Z0-9]{2,12}$/.test(t)||!/^[a-z0-9-]{2,60}$/.test(id))throw new Error('Invalid coin sync record.');
      if(!doc.coins[t]){doc.coins[t]={ticker:t,id:id,name:String(op.name||t).slice(0,120),sample:Number(op.sample)>0?Number(op.sample):1,vs:'gbp',favourite:!!op.favourite};changed=true;}
      else if(!seed){
        const c=doc.coins[t];c.id=id;c.name=String(op.name||t).slice(0,120);if(Number(op.sample)>0)c.sample=Number(op.sample);
        if(typeof op.favourite==='boolean')c.favourite=op.favourite;
        changed=true;
      }
    }
    // Legacy journal migration only on creation. Client supplies known built-in IDs
    // as part of its one-time local import; existing records always win on import.
    if(!sh){
      const legacy=loadJournalState(),settings=legacy&&legacy.settings;
      if(settings){
        const fav=settings.watchlist||[],all=(request.catalog||[]).concat(settings.customCoins||[]);
        all.forEach(function(c){if((settings.coinLibrary||[]).indexOf(c.ticker)>=0||fav.indexOf(c.ticker)>=0)putMeta(Object.assign({},c,{favourite:fav.indexOf(c.ticker)>=0}),true);});
      }
    }
    const seed=Array.isArray(request.seed)?request.seed:[];
    seed.forEach(function(op){putMeta(op,true);});
    const ops=Array.isArray(request.operations)?request.operations:[];
    if(ops.length>2000)throw new Error('Too many coin changes in one sync.');
    const ack=[];
    ops.forEach(function(op){
      const token=String(op.token||'');if(!/^[a-zA-Z0-9_-]{8,100}$/.test(token))throw new Error('Invalid coin operation ID.');
      ack.push(token);if(doc.seen.indexOf(token)>=0)return;
      putMeta(op,false);doc.seen.push(token);
    });
    doc.seen=doc.seen.slice(-5000);
    if(changed){
      doc.revision++;doc.updatedAt=new Date().toISOString();
      const json=JSON.stringify(doc);if(json.length>500000)throw new Error('Coin preferences exceed sync capacity. Export a backup before adding more.');
      if(!sh){sh=ss.insertSheet('_CoinLibrary');try{sh.hideSheet();}catch(e){}}
      sh.getRange('A1').setValue('COIN_LIBRARY_V1');
      const parts=[];for(let i=0;i<json.length;i+=40000)parts.push([json.slice(i,i+40000)]);
      sh.getRange(2,1,parts.length,1).setValues(parts);
      const last=sh.getLastRow();if(last>parts.length+1)sh.getRange(parts.length+2,1,last-parts.length-1,1).clearContent();
    }
    return {version:1,revision:doc.revision,updatedAt:doc.updatedAt||null,coins:Object.keys(doc.coins).map(function(t){return doc.coins[t];}),ack:ack};
  } finally {lock.releaseLock();}
}
