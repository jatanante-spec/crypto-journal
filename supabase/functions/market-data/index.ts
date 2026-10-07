/**
 * Crypto Journal development market-data Edge Function.
 *
 * Ported from the complete Apps Script source in /home/user/uploads/Code.js.
 * The provider order and validation semantics are intentionally retained:
 * CoinGecko market data -> Yahoo market fallback; Yahoo genuine hourly OHLC
 * -> Kraken validated OHLC -> CoinGecko price-only hourly observations.
 * Price-only hourly data never supplies an invented hourly ATR.
 * Hourly volume is overlaid from Coinbase for the same hours when available (CLIMATE-PLUS-1).
 *
 * This file is development-only. It does not read or write journal state.
 * Supabase Auth/JWT verification remains enabled at deployment time.
 */

const edgeCache = (() => {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(String(key));
      if (!hit || hit.expiresAt <= Date.now()) {
        store.delete(String(key));
        return null;
      }
      return hit.value;
    },
    put(key, value, seconds) {
      store.set(String(key), { value: String(value), expiresAt: Date.now() + Number(seconds || 0) * 1000 });
    },
  };
})();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function searchCoins(query) {
  const q = String(query || "").trim();
  if (q.length < 1) return [];
  const url =
    "https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(q);
  const data = await fetchJson_(url);
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
async function peekLive(coinId, vs, ticker) {
  const market = await fetchMarket(coinId, vs, ticker);
  market.hourTrendSupport = null;
  market.hourlyFeed = null;
  market.hourlyOhlc = [];
  let closes = [];
  let hourly = [];
  let hourlyVolumes = [];
  let hourlyAts = [];
  let atrHourly = 0;
  try {
    closes = await fetchDailyCloses(coinId, vs, ticker);
  } catch (err) {
    console.warn("peek closes failed: " + err);
  }
  try {
    const hourPack = await fetchHourlyPack(coinId, vs, ticker);
    hourly = hourPack.closes || [];
    hourlyVolumes = hourPack.volumes || [];
    hourlyAts = hourPack.ats || [];
    atrHourly = hourPack.atrHourly || 0;
    market.hourTrendSupport = hourPack.trendSupport || null;
    market.hourlyFeed = hourPack.feed || null;
    market.hourlyOhlc = (hourPack.ohlc || []).slice(-168);
  } catch (err) {
    console.warn("peek hourly failed: " + err);
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

async function fetchLive(coinId, vs, ticker) {
  // CLIMATE-PLUS-1 · started first so it runs alongside the existing calls; it never rejects.
  const climateCtxJob = cpClimateCtx_(coinId, vs, ticker);
  const market = await fetchMarket(coinId, vs, ticker);
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
    closes = await fetchDailyCloses(coinId, vs, ticker);
  } catch (err) {
    console.warn("closes failed after market ok: " + err);
  }
  try {
    atr14 = await fetchAtr(coinId, vs, ticker);
  } catch (err) {
    console.warn("ATR failed: " + err);
  }
  try {
    const hourPack = await fetchHourlyPack(coinId, vs, ticker);
    hourly = hourPack.closes || [];
    hourlyVolumes = hourPack.volumes || [];
    hourlyAts = hourPack.ats || [];
    atrHourly = hourPack.atrHourly || 0;
    market.hourTrendSupport = hourPack.trendSupport || null;
    market.hourlyFeed = hourPack.feed || null;
    market.hourlyOhlc = (hourPack.ohlc || []).slice(-168);
  } catch (err) {
    console.warn("hourly failed: " + err);
  }
  market.climateCtx = await climateCtxJob;
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

async function fetchHourlyCloses(coinId, vs, ticker) {
  return (await fetchHourlyPack(coinId, vs, ticker)).closes;
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
async function fetchHourlyPack(coinId, vs, ticker) {
  const id=String(coinId||'solana'),cur=String(vs||'gbp').toLowerCase(),symbol=String(ticker||'SOL').toUpperCase(),attempts=[];
  function attach(p,source,status,note){
    p.feed={fx:p.fx||null,volumeSource:p.volumeSource||null,version:1,coinId:id,ticker:symbol,currency:cur,source:source,status:status,barAt:p.ats&&p.ats.length?p.ats[p.ats.length-1]:null,count:(p.closes||[]).length,retrievedAt:new Date().toISOString(),attempts:attempts.slice(),note:note};return p;
  }
  try {
    bpKrakenAsset_(id,symbol); // Shared canonical ID/ticker allowlist before either candle provider.
    const p=await fetchHourlyFromYahoo_(symbol,cur);
    if(!(p.atrHourly>0&&isFinite(p.atrHourly)))throw new Error('Hourly ATR invalid');
    await cpOverlayVolume_(p,symbol,cur,'Yahoo');
    attempts.push({source:'Yahoo',status:'READY'});
    return attach(p,'Yahoo hourly OHLC (GBP may use USD conversion)','READY','Candles and ATR come from the same hourly series. Quote/range can use a different provider. Yahoo GBP fallback may scale USD candles using its cached GBPUSD rate, not historical hourly FX.');
  }catch(e){attempts.push({source:'Yahoo',status:'FAILED',reason:bpFeedReason_(e)});}
  try {
    const p=await fetchHourlyFromKraken_(id,cur,symbol);
    await cpOverlayVolume_(p,symbol,cur,'Kraken');
    attempts.push({source:'Kraken',status:'READY'});
    return attach(p,'Kraken '+p.pair+' hourly OHLC','READY',p.fx?'USD exchange candles converted to GBP using one completed GBP/USD candle close at '+p.fx.at+'. This is not historical hourly FX adjustment or a native GBP market. Quote/range providers may differ.':'Native quote-currency exchange candles; no FX conversion. Candle and quote/range providers may differ.');
  }catch(e){attempts.push({source:'Kraken',status:'FAILED',reason:bpFeedReason_(e)});}
  try {
    const p=await fetchHourlyFromCoinGecko_(id,cur);
    await cpOverlayVolume_(p,symbol,cur,'CoinGecko');
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
async function fetchHourlyFromKraken_(coinId,currency,ticker){
  if(!/^(gbp|usd|eur)$/.test(currency))throw new Error('Unsupported Kraken currency');
  const asset=bpKrakenAsset_(coinId,ticker),quote=currency.toUpperCase();
  try{return await bpKrakenNative_(asset,quote);}catch(e){
    if(currency!=='gbp'||isRateLimitErr_(e))throw e;
    const usd=await bpKrakenNative_(asset,'USD');
    const cache=edgeCache;let fx=null;
    try{fx=JSON.parse(cache.get('bp1_kraken_gbpusd_fx')||'null');}catch(ignore){}
    if(!fx||!(fx.rate>0)||!isFinite(fx.rate)||!isFinite(Date.parse(fx.at))||Date.now()-Date.parse(fx.at)>3*3600000||Date.parse(fx.at)>Date.now()){
      const fp=await bpKrakenNative_('GBP','USD');fx={rate:fp.closes[fp.closes.length-1],at:fp.ats[fp.ats.length-1],source:'Kraken GBP/USD completed hourly close'};
      try{cache.put('bp1_kraken_gbpusd_fx',JSON.stringify(fx),600);}catch(ignore){}
    }
    if(!(fx.rate>0&&isFinite(fx.rate))||!isFinite(Date.parse(fx.at))||Date.now()-Date.parse(fx.at)>3*3600000)throw new Error('Stale or invalid FX candle');
    usd.closes=usd.closes.map(function(v){return v/fx.rate;});usd.atrHourly/=fx.rate;usd.ohlc=(usd.ohlc||[]).map(function(r){return [r[0],r[1]/fx.rate,r[2]/fx.rate,r[3]/fx.rate,r[4]/fx.rate];});usd.fx=fx;usd.pair=asset+'/USD converted to GBP';return usd;
  }
}
async function bpKrakenNative_(asset,quote){
  const wanted=asset+'/'+quote,query=asset+quote;
  const cache=edgeCache,cacheKey='bp1_pair_'+query;
  let pair=null,cached=cache.get(cacheKey);
  if(cached){try{pair=JSON.parse(cached);}catch(e){}}
  if(!pair){
    const data=await fetchJson_('https://api.kraken.com/0/public/AssetPairs?pair='+encodeURIComponent(query));
    if(data.error&&data.error.length)throw new Error(/rate limit/i.test(data.error.join(' '))?'Kraken rate limit':'Kraken pair unavailable');
    const results=data.result||{},keys=Object.keys(results).filter(function(k){const p=results[k];return p.wsname===wanted&&p.status==='online';});
    if(keys.length!==1)throw new Error('Kraken pair identity mismatch');
    const found=results[keys[0]];pair={key:keys[0],altname:found.altname,wsname:found.wsname};
    try{cache.put(cacheKey,JSON.stringify(pair),3600);}catch(e){}
  }
  if(pair.wsname!==wanted||!pair.key||!pair.altname)throw new Error('Cached pair identity mismatch');
  const data=await fetchJson_('https://api.kraken.com/0/public/OHLC?pair='+encodeURIComponent(pair.altname)+'&interval=60');
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

async function fetchHourlyFromCoinGecko_(id, currency) {
  const base = "https://api.coingecko.com/api/v3/coins/" + encodeURIComponent(id) +
    "/market_chart?vs_currency=" + encodeURIComponent(currency) + "&days=7";
  let data;
  try { data = await fetchJson_(base + "&interval=hourly"); }
  catch (err) { if (isRateLimitErr_(err)) throw err; data = await fetchJson_(base); }
  const pack = validatedHourlyTail_(bucketHourlySeries_(data.prices || [], []));
  // Hourly price observations can support RSI, but are not OHLC candles.
  return { closes: pack.closes, volumes: pack.volumes, ats: pack.ats, atrHourly: 0 };
}

async function fetchHourlyFromYahoo_(ticker, currency) {
  const chart = await yahooChart_(ticker, currency, "60m", "7d");
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
    // Yahoo crypto often reports 0 for hours it has no volume for: missing data, never "quiet".
    pack.volumes.push(v != null && isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    pack.ats.push(new Date(ts).toISOString());
    pack.bars.push({o:raw.open&&raw.open[i]!=null?Number(raw.open[i]):null,h:Number(h), l:Number(l), c:Number(c)});
  });
  const tail = validatedHourlyTail_(pack);
  return {closes:tail.closes, volumes:tail.volumes, ats:tail.ats, ohlc:tail.bars.map(function(b,i){return [tail.ats[i],b.o,b.h,b.l,b.c];}),atrHourly:atrFromBars_(tail.bars),trendSupport:hourlyAdx_(tail.bars,tail.ats[tail.ats.length-1])};
}

async function fetchAtr(coinId, vs, ticker) {
  const id = String(coinId || "solana");
  const currency = String(vs || "gbp").toLowerCase();
  const symbol = String(ticker || "SOL").toUpperCase();
  const errors = [];
  try {
    return await fetchAtrFromCoinGecko_(id, currency);
  } catch (err) {
    errors.push(err.message);
  }
  try {
    return await fetchAtrFromYahoo_(symbol, currency);
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

async function fetchAtrFromCoinGecko_(id, currency) {
  const rows = await fetchJson_("https://api.coingecko.com/api/v3/coins/" + encodeURIComponent(id) +
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

async function fetchAtrFromYahoo_(ticker, currency) {
  const chart = await yahooChart_(ticker, currency);
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

async function fetchMarket(coinId, vs, ticker) {
  const id = String(coinId || "solana");
  const currency = String(vs || "gbp").toLowerCase();
  const symbol = String(ticker || "SOL").toUpperCase();
  const errors = [];
  try {
    return await fetchMarketFromCoinGeckoMarkets_(id, currency);
  } catch (err) {
    errors.push(err.message);
    // On 429, skip the second CoinGecko call — same quota, burns the fallback.
    if (!isRateLimitErr_(err)) {
      try {
        return await fetchMarketFromCoinGeckoCoin_(id, currency);
      } catch (err2) {
        errors.push(err2.message);
      }
    }
  }
  try {
    return await fetchMarketFromYahoo_(symbol, currency);
  } catch (err) {
    errors.push(err.message);
  }
  throw new Error("Live fetch failed. " + errors.join(" | "));
}

async function fetchDailyCloses(coinId, vs, ticker) {
  const id = String(coinId || "solana");
  const currency = String(vs || "gbp").toLowerCase();
  const symbol = String(ticker || "SOL").toUpperCase();
  const errors = [];
  try {
    return await fetchClosesFromCoinGecko_(id, currency);
  } catch (err) {
    errors.push(err.message);
  }
  try {
    return (await fetchClosesFromYahoo_(symbol, currency)).slice(-60);
  } catch (err) {
    errors.push(err.message);
  }
  throw new Error("Closes fetch failed. " + errors.join(" | "));
}

async function fetchMarketFromCoinGeckoMarkets_(id, currency) {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=" +
    encodeURIComponent(currency) +
    "&ids=" +
    encodeURIComponent(id) +
    "&price_change_percentage=24h,7d,14d,30d";
  const rows = await fetchJson_(url);
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

async function fetchMarketFromCoinGeckoCoin_(id, currency) {
  const url =
    "https://api.coingecko.com/api/v3/coins/" +
    encodeURIComponent(id) +
    "?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false";
  const data = await fetchJson_(url);
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

async function fetchClosesFromCoinGecko_(id, currency) {
  const url =
    "https://api.coingecko.com/api/v3/coins/" +
    encodeURIComponent(id) +
    "/market_chart?vs_currency=" +
    encodeURIComponent(currency) +
    "&days=365";
  const data = await fetchJson_(url);
  const prices = data.prices || [];
  if (!prices.length) throw new Error("CoinGecko market_chart returned no prices.");
  return prices.map(function (row) {
    return Number(row[1]);
  }).slice(-60);
}

async function fetchMarketFromYahoo_(ticker, currency) {
  const pack = await yahooChartPack_(ticker, currency, "1d", "3mo");
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

async function fetchClosesFromYahoo_(ticker, currency) {
  const pack = await yahooChartPack_(ticker, currency, "1d", "3mo");
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
async function yahooChart_(ticker, currency, interval, range) {
  return (await yahooChartPack_(ticker, currency, interval, range)).chart;
}

async function yahooChartPack_(ticker, currency, interval, range) {
  const cur = String(currency || "gbp").toUpperCase();
  const sym = String(ticker || "SOL").toUpperCase();
  const errors = [];
  try {
    return {
      chart: await yahooChartSymbol_(sym + "-" + cur, interval, range),
      viaUsd: false,
    };
  } catch (err) {
    errors.push(err.message);
  }
  if (cur === "GBP") {
    try {
      const usdChart = await yahooChartSymbol_(sym + "-USD", interval, range);
      let mult = 1;
      if (cur === "GBP") {
        const usdPerGbp = await yahooUsdPerGbp_();
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

async function yahooChartSymbol_(yahooSymbol, interval, range) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSymbol) +
    "?interval=" +
    encodeURIComponent(interval || "1d") +
    "&range=" +
    encodeURIComponent(range || "3mo");
  const data = await fetchJson_(url);
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error("Yahoo empty result for " + yahooSymbol + ".");
  if(String(result.meta && result.meta.symbol || "").toUpperCase() !== String(yahooSymbol).toUpperCase())throw new Error("Yahoo symbol mismatch");
  if(yahooSymbol.indexOf("-")>=0 && String(result.meta && result.meta.currency || "").toUpperCase()!==String(yahooSymbol).split("-").pop().toUpperCase())throw new Error("Yahoo currency mismatch");
  const err = data.chart && data.chart.error;
  if (err && err.description) throw new Error("Yahoo " + yahooSymbol + ": " + err.description);
  return result;
}

/** USD per 1 GBP from Yahoo GBPUSD=X. Cached ~1h. */
async function yahooUsdPerGbp_() {
  const cache = edgeCache;
  const hit = cache.get("fx_usd_per_gbp");
  if (hit && Number(hit) > 0) return Number(hit);
  const chart = await yahooChartSymbol_("GBPUSD=X", "1d", "5d");
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

async function fetchJson_(url) {
  const headers = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; CryptoScalpingJournal/1.0)",
  };
  const demoKey = Deno.env.get("COINGECKO_DEMO_KEY");
  if (demoKey && url.indexOf("coingecko.com") !== -1) {
    headers["x-cg-demo-api-key"] = demoKey;
  }
  const options = { redirect: "follow", headers: headers };
  let res = await fetch(url, options);
  let code = res.status;
  // Free CoinGecko is strict — back off harder before Yahoo fallback.
  if (code === 429) {
    await sleep(2500);
    res = await fetch(url, options);
    code = res.status;
  }
  if (code === 429) {
    await sleep(4000);
    res = await fetch(url, options);
    code = res.status;
  }
  const text = await res.text();
  if (code !== 200) {
    const host = url.split("/")[2] || "source";
    const snippet = String(text || "").replace(/\s+/g, " ").slice(0, 160);
    throw new Error(host + " " + code + (snippet ? " — " + snippet : ""));
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid JSON from " + (url.split("/")[2] || "source") + ".");
  }
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


/* CLIMATE-PLUS-1 · extra public context for the Market climate. Display only: nothing here feeds the
   entry verdict, Gates, sizing or tickets. Sources: Coinbase Exchange candles (hourly volume, volatility,
   backdrop trends) and OKX perpetual-swap funding / open interest. Every call has a short timeout and is
   cached briefly; a failure only leaves that one reading Unknown and is listed in climateCtx.errors. */
function cpMsg_(e) { return String((e && e.message) || e || "failed"); }
async function cpJson_(url, ms) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; CryptoScalpingJournal/1.0)" },
    signal: AbortSignal.timeout(ms || 5000),
  });
  const text = await res.text(), host = url.split("/")[2] || "source";
  if (res.status !== 200) throw new Error(host + " " + res.status);
  try { return JSON.parse(text); } catch (e) { throw new Error("Invalid JSON from " + host + "."); }
}
async function cpCached_(key, seconds, make) {
  const hit = edgeCache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* refetch */ } }
  const value = await make();
  try { edgeCache.put(key, JSON.stringify(value), seconds); } catch (e) { /* cache is best effort */ }
  return value;
}
/** Completed Coinbase candles, oldest first: [{t(ms),o,h,l,c,v}]. The current, unfinished candle is excluded. */
function cpCoinbaseCandles_(product, gran, count) {
  return cpCached_("cp_cb_" + product + "_" + gran + "_" + count, gran === 3600 ? 300 : 900, async function () {
    const nowSec = Math.floor(Date.now() / 1000), cutoff = nowSec - (nowSec % gran), jobs = [];
    for (let k = 0; k < Math.ceil(count / 300); k++) {
      const end = cutoff - k * 300 * gran, start = end - 300 * gran;
      jobs.push(cpJson_("https://api.exchange.coinbase.com/products/" + encodeURIComponent(product) +
        "/candles?granularity=" + gran + "&start=" + start + "&end=" + end, 5000));
    }
    const pages = await Promise.all(jobs), byT = {};
    pages.forEach(function (rows) {
      if (!Array.isArray(rows)) throw new Error("Coinbase candles unavailable");
      rows.forEach(function (r) { // [time, low, high, open, close, volume]
        if (!Array.isArray(r) || r.length < 6) return;
        const t = Number(r[0]), l = Number(r[1]), h = Number(r[2]), o = Number(r[3]), c = Number(r[4]), v = Number(r[5]);
        if (!isFinite(t) || t % gran !== 0 || t >= cutoff) return;
        if (![o, h, l, c].every(function (x) { return x > 0 && isFinite(x); }) || h < l || c > h || c < l) return;
        byT[t] = { t: t * 1000, o: o, h: h, l: l, c: c, v: v > 0 && isFinite(v) ? v : null };
      });
    });
    const out = Object.keys(byT).map(Number).sort(function (a, b) { return a - b; }).map(function (t) { return byT[t]; });
    if (!out.length) throw new Error("Coinbase returned no completed candles");
    return out.slice(-count);
  });
}
/** Coin in the display currency first, then the USD market. Volume is in coin units either way. */
async function cpCoinbaseProduct_(ticker, cur, gran, count) {
  const tries = [ticker + "-" + String(cur).toUpperCase()];
  if (String(cur).toLowerCase() !== "usd") tries.push(ticker + "-USD");
  let last = null;
  for (const product of tries) {
    try { return { product: product, bars: await cpCoinbaseCandles_(product, gran, count) }; }
    catch (e) { last = e; if (isRateLimitErr_(e)) break; }
  }
  throw last || new Error("No Coinbase market");
}
/** Replace an hourly pack's volumes with Coinbase volume for the same hours. Never throws. */
async function cpOverlayVolume_(p, ticker, cur, own) {
  try {
    const got = await cpCoinbaseProduct_(ticker, cur, 3600, 300), byT = {};
    got.bars.forEach(function (b) { byT[b.t] = b.v; });
    let matched = 0;
    const vols = (p.ats || []).map(function (at) {
      const v = byT[Date.parse(at)];
      if (v != null && v > 0) { matched++; return v; }
      return null; // an hour Coinbase did not report stays missing
    });
    if (matched < Math.min(15, vols.length)) throw new Error("Coinbase volume did not cover the hourly window");
    p.volumes = vols;
    p.volumeSource = { source: "Coinbase " + got.product, status: "READY", matched: matched, count: vols.length };
  } catch (e) {
    p.volumeSource = { source: own + " (own volume)", status: "FALLBACK", reason: bpFeedReason_(e) };
  }
  return p;
}
function cpEma_(values, n) {
  if (values.length < n) return [];
  const k = 2 / (n + 1), out = [];
  let e = values.slice(0, n).reduce(function (a, b) { return a + b; }, 0) / n;
  out.push(e);
  for (let i = n; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}
/** Close vs a 20-period EMA and that EMA three periods earlier. The app decides what it means. */
function cpTrend_(bars, source) {
  if (!bars || bars.length < 24) throw new Error("Too few candles for a trend");
  const closes = bars.map(function (b) { return b.c; }), e = cpEma_(closes, 20);
  return { close: closes[closes.length - 1], ema: e[e.length - 1], emaPrev: e[e.length - 4],
    at: new Date(bars[bars.length - 1].t).toISOString(), n: bars.length, source: source };
}
/** Complete UTC 4-hour candles from four consecutive completed hours. */
function cpFourHour_(bars) {
  const groups = {}, keys = [];
  bars.forEach(function (b) { const k = Math.floor(b.t / 14400000); if (!groups[k]) { groups[k] = []; keys.push(k); } groups[k].push(b); });
  return keys.filter(function (k) { return groups[k].length === 4; })
    .map(function (k) { const g = groups[k]; return { t: k * 14400000, c: g[3].c }; });
}
/** Hourly ATR(14, Wilder) now, and where it ranks among this window's earlier hourly ATRs. */
function cpVolatility_(got) {
  const bars = got.bars;
  if (bars.length < 14 + 168) throw new Error("Need at least a week of hourly candles");
  const atrs = [];
  let a = null, trSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c, tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (i <= 14) { trSum += tr; if (i === 14) { a = trSum / 14; atrs.push(a); } }
    else { a = (a * 13 + tr) / 14; atrs.push(a); }
  }
  const now = atrs[atrs.length - 1], last = bars[bars.length - 1];
  const below = atrs.filter(function (x) { return x <= now; }).length;
  return { atr: now, atrPct: now / last.c * 100, pctl: Math.round(below / atrs.length * 100), hours: atrs.length,
    currency: got.product.split("-")[1], at: new Date(last.t).toISOString(), source: "Coinbase " + got.product + " hourly" };
}
function cpOkxPositioning_(ticker) {
  const inst = ticker + "-USDT-SWAP", base = "https://www.okx.com/api/v5/";
  return cpCached_("cp_okx_" + inst, 300, async function () {
    const all = await Promise.all([
      cpJson_(base + "public/funding-rate?instId=" + encodeURIComponent(inst), 5000),
      cpJson_(base + "public/funding-rate-history?instId=" + encodeURIComponent(inst) + "&limit=30", 5000),
      cpJson_(base + "rubik/stat/contracts/open-interest-volume?ccy=" + encodeURIComponent(ticker) + "&period=1H", 5000),
    ]);
    const fr = all[0] && all[0].code === "0" && all[0].data && all[0].data[0];
    if (!fr || fr.instId !== inst) throw new Error("OKX funding unavailable for " + inst);
    const funding = Number(fr.fundingRate) * 100;
    if (!isFinite(funding)) throw new Error("OKX funding invalid");
    const hist = (all[1] && all[1].code === "0" && all[1].data || []).map(function (x) { return Number(x.realizedRate) * 100; })
      .filter(function (x) { return isFinite(x); });
    const oi = (all[2] && all[2].code === "0" && all[2].data || []).map(function (r) { return [Number(r[0]), Number(r[1])]; })
      .filter(function (r) { return isFinite(r[0]) && r[1] > 0; }).sort(function (a, b) { return a[0] - b[0]; });
    let oiUsd = null, oiChg24 = null;
    if (oi.length) {
      const lastOi = oi[oi.length - 1], dayAgo = oi.filter(function (r) { return r[0] === lastOi[0] - 86400000; })[0];
      oiUsd = lastOi[1];
      if (dayAgo) oiChg24 = (lastOi[1] / dayAgo[1] - 1) * 100;
    }
    const interval = (Number(fr.nextFundingTime) - Number(fr.fundingTime)) / 3600000;
    return { funding: funding, fundingAvg: hist.length ? hist.reduce(function (a, b) { return a + b; }, 0) / hist.length : null,
      fundingN: hist.length, intervalH: interval > 0 && interval <= 24 ? interval : 8, oiUsd: oiUsd, oiChg24: oiChg24,
      at: new Date(Number(fr.ts) || Date.now()).toISOString(), source: "OKX " + inst };
  });
}
/** Small summary for the climate readings; arrays stay on the server. Never rejects. */
async function cpClimateCtx_(coinId, vs, ticker) {
  const id = String(coinId || "solana"), cur = String(vs || "gbp").toLowerCase(), sym = String(ticker || "SOL").toUpperCase();
  const ctx = { version: 1, retrievedAt: new Date().toISOString(), volatility: null, backdrop: null, positioning: null, errors: [] };
  try {
    try { bpKrakenAsset_(id, sym); } catch (e) { ctx.errors.push("Coin identity is not on the verified list; context skipped."); return ctx; }
    const r = await Promise.allSettled([
      cpCoinbaseProduct_(sym, cur, 3600, 720),
      cpCoinbaseProduct_(sym, cur, 86400, 60),
      sym === "BTC" ? Promise.resolve(null) : cpCoinbaseProduct_("BTC", cur, 86400, 60),
      cpOkxPositioning_(sym),
    ]);
    const why = function (x) { return bpFeedReason_(x.reason); };
    if (r[0].status === "fulfilled") {
      try { ctx.volatility = cpVolatility_(r[0].value); } catch (e) { ctx.errors.push("Volatility: " + cpMsg_(e)); }
    } else ctx.errors.push("Volatility: " + why(r[0]));
    const bd = { coin: null, h4: null, btc: null };
    if (r[1].status === "fulfilled") { try { bd.coin = cpTrend_(r[1].value.bars, "Coinbase " + r[1].value.product + " daily"); } catch (e) { ctx.errors.push("Backdrop daily: " + cpMsg_(e)); } }
    else ctx.errors.push("Backdrop daily: " + why(r[1]));
    if (r[0].status === "fulfilled") { try { bd.h4 = cpTrend_(cpFourHour_(r[0].value.bars), "Coinbase " + r[0].value.product + " 4-hour"); } catch (e) { ctx.errors.push("Backdrop 4-hour: " + cpMsg_(e)); } }
    if (r[2].status === "fulfilled" && r[2].value) { try { bd.btc = cpTrend_(r[2].value.bars, "Coinbase " + r[2].value.product + " daily"); } catch (e) { ctx.errors.push("Backdrop BTC: " + cpMsg_(e)); } }
    else if (r[2].status === "rejected") ctx.errors.push("Backdrop BTC: " + why(r[2]));
    if (bd.coin || bd.h4 || bd.btc) ctx.backdrop = bd;
    if (r[3].status === "fulfilled") ctx.positioning = r[3].value;
    else ctx.errors.push("Positioning: " + why(r[3]));
  } catch (e) {
    ctx.errors.push("Context failed: " + bpFeedReason_(e));
  }
  return ctx;
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    }, headers || {}),
  });
}

function cleanText(value, fallback, maxLength) {
  const text = String(value == null ? fallback || "" : value).trim();
  return text.slice(0, maxLength || 200);
}

function validateMarketArgs(args) {
  if (!Array.isArray(args) || args.length < 3) {
    throw new Error("Market-data request needs coin id, quote currency and ticker.");
  }
  const coinId = cleanText(args[0], "", 80).toLowerCase();
  const vs = cleanText(args[1], "gbp", 10).toLowerCase();
  const ticker = cleanText(args[2], "", 16).toUpperCase();
  if (!/^[a-z0-9-]{2,60}$/.test(coinId)) throw new Error("Invalid coin id.");
  if (!/^(gbp|usd|eur)$/.test(vs)) throw new Error("Unsupported quote currency.");
  if (!/^[A-Z0-9]{2,12}$/.test(ticker)) throw new Error("Invalid coin ticker.");
  return [coinId, vs, ticker];
}

async function dispatchMarket(operation, args) {
  if (operation === "searchCoins") {
    const query = cleanText(Array.isArray(args) ? args[0] : "", "", 80);
    if (query.length < 1) return [];
    return searchCoins(query);
  }
  const normalized = validateMarketArgs(args);
  if (operation === "peekLive") return peekLive(...normalized);
  if (operation === "fetchLive") return fetchLive(...normalized);
  throw new Error("Unsupported market-data operation.");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return jsonResponse({ ok: true });
  if (request.method !== "POST") return jsonResponse({ error: "POST required." }, 405);
  try {
    const body = await request.json();
    const operation = cleanText(body && body.operation, "", 40);
    const args = body && Array.isArray(body.args) ? body.args : [];
    const result = await dispatchMarket(operation, args);
    return jsonResponse({ ok: true, result: result });
  } catch (error) {
    console.warn("market-data request failed", error);
    return jsonResponse({
      ok: false,
      error: error && error.message ? error.message : String(error),
    }, 400);
  }
});
