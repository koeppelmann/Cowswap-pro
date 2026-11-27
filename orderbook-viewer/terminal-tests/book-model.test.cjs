const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildBook}=require('../assets/book-model.js');
const metadata={eth:{symbol:'WETH',decimals:18},btc:{symbol:'WBTC',decimals:8},usd:{symbol:'USDC',decimals:6},dai:{symbol:'DAI',decimals:18}};
const defaults={baseDecimals:18,depthUnit:'usd',metadata,quoteRates:{usd:'1',dai:'1.02'}};
const row=(uid,side,price,base=1,quote=100,extra={})=>({uid,owner:'owner-'+uid,side,base_token:'eth',quote_token:'usd',quote_symbol:'USDC',normalized_price:String(price),allocated_sell_atoms:'1',allocated_base_atoms:String(BigInt(base)*10n**18n),allocated_quote_atoms:String(BigInt(quote)*10n**6n),funding_status:'fully_allocated',...extra});
const book=(rows,options={})=>buildBook(rows,{...defaults,...options});
const shape=rows=>rows.map(r=>[r.order.uid,r.price,r.size,r.total,Math.round(r.depthPercent*1e6)/1e6]);
test('asks descend visually, but accumulate from best ask toward worse asks',()=>{
 const input=[row('expensive','ask',110,3,300),row('best','ask',100,1,100),row('middle','ask',105,2,200)];
 const before=JSON.stringify(input); const b=book(input);
 assert.deepEqual(shape(b.asks),[['expensive',110,300,600,100],['middle',105,200,300,50],['best',100,100,100,16.666667]]);
 assert.equal(b.asks[2].order,input[1]); assert.equal(JSON.stringify(input),before);
});
test('bids descend and accumulate from the best bid independently of asks',()=>{
 const b=book([row('low','bid',90,1,100),row('high','bid',99,2,200),row('ask','ask',101,1,900)]);
 assert.deepEqual(shape(b.bids),[['high',99,200,200,66.666667],['low',90,100,300,100]]);
 assert.equal(b.mid,100); assert.equal(b.midSource,'both');assert.equal(b.bestBid,99);assert.equal(b.bestAsk,101);
});
test('individual orders at a shared price stay distinct with deterministic UID accumulation',()=>{
 const b=book([row('b','bid',99),row('a','bid',99),row('b-ask','ask',101),row('a-ask','ask',101)]);
 assert.deepEqual(b.bids.map(r=>[r.order.uid,r.total]),[['a',100],['b',200]]);
 assert.deepEqual(b.asks.map(r=>[r.order.uid,r.total]),[['b-ask',200],['a-ask',100]]);
});
test('search limits displayed rows while preserving full-side totals, depth and midpoint',()=>{
 const rows=[row('best','bid',99),row('target','bid',98),row('ask','ask',101)];const all=book(rows);const found=book(rows,{search:'TARGET'});
 assert.deepEqual(found.bids,[all.bids[1]]);assert.equal(found.asks.length,0);assert.equal(found.mid,100);
 assert.equal(book(rows,{search:'  owner-target  '}).bids.length,1);
 assert.equal(book(rows,{search:'weth'}).bids.length,2);
});
test('unfunded orders are absent by default and add zero depth when requested',()=>{
 const rows=[row('funded','bid',99),row('unfunded','bid',100,50,5000,{allocated_sell_atoms:'0',allocated_base_atoms:'0',allocated_quote_atoms:'0',funding_status:'not_allocated'})];
 assert.equal(book(rows).bids.length,1);const b=book(rows,{includeUnfunded:true});
 assert.deepEqual(shape(b.bids),[['unfunded',100,0,0,0],['funded',99,100,100,100]]);assert.equal(b.bestBid,99);
});
test('base units honor selected market decimals including WBTC eight decimals',()=>{
 assert.equal(book([row('eth','bid',99,2)],{depthUnit:'base'}).bids[0].size,2);
 const btc=row('btc','ask',90000,1,100,{base_token:'btc',allocated_base_atoms:'12500000'});
 assert.equal(book([btc],{baseDecimals:8,depthUnit:'base'}).asks[0].size,0.125);
});
test('quote depth uses quote decimals and quote reference rates without rewriting price',()=>{
 const r=row('dai','ask',103,1,1,{quote_token:'dai',quote_symbol:'DAI',allocated_quote_atoms:'2000000000000000000'});
 const b=book([r]);assert.equal(b.asks[0].size,2.04);assert.equal(b.asks[0].price,103);assert.equal(r.normalized_price,'103');
});
test('midpoint ignores dust and distinguishes absent and single-sided markets',()=>{
 assert.deepEqual([book([]).mid,book([]).midSource],[null,'none']);
 const bid=book([row('bid','bid',99),row('dust','bid',1000,1,0)]);assert.equal(bid.mid,99);assert.equal(bid.midSource,'bid');
 const ask=book([row('ask','ask',101)]);assert.equal(ask.mid,101);assert.equal(ask.midSource,'ask');
});
test('crossed same-token prices remain a valid cross; differing quote or base marks reference overlap',()=>{
 const bid=row('bid','bid',102);const ask=row('ask','ask',100);
 assert.equal(book([bid,ask]).referenceOverlap,false);
 assert.equal(book([bid,{...ask,quote_token:'dai',quote_symbol:'DAI',allocated_quote_atoms:'2000000000000000000'}]).referenceOverlap,true);
 assert.equal(book([bid,{...ask,base_token:'btc'}]).referenceOverlap,true);
 assert.equal(book([bid,row('ask','ask',103)]).referenceOverlap,false);
});
