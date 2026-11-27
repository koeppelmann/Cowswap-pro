const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const model = require(process.env.DFUSION_TAKE_MODEL || path.join(__dirname,'../assets/take-model.js'));
const cases = require('./cases.json');
const WBTC='0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const USDC='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ETH='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const metadata={ [WBTC]:{symbol:'WBTC',decimals:8},[USDC]:{symbol:'USDC',decimals:6},[WETH]:{symbol:'WETH',decimals:18},[ETH]:{symbol:'ETH',decimals:18} };
const now=1800000000;
function fixture(c=cases[0],patch={}) {
  const sell=c.side==='ask'?WBTC:USDC,buy=c.side==='ask'?USDC:WBTC;
  return {uid:'0x'+'ab'.repeat(56),owner:'0x'+'12'.repeat(20),side:c.side,kind:c.kind,
    sell_token:sell,buy_token:buy,base_token:WBTC,quote_token:USDC,
    signed_sell_atoms:c.sourceSell,signed_buy_atoms:c.sourceBuy,
    remaining_sell_atoms:c.sourceSell,remaining_buy_atoms:c.sourceBuy,
    allocated_sell_atoms:c.allocatedSell,allocated_buy_atoms:c.sourceBuy,
    allocated_base_atoms:'777777777777777777777777777',allocated_actual_base_atoms:c.side==='ask'?c.allocatedSell:c.sourceBuy,
    allocated_quote_atoms:c.side==='ask'?c.sourceBuy:c.allocatedSell,
    funding_status:c.allocatedSell===c.sourceSell?'fully_allocated':'partially_allocated',
    partially_fillable:true,fee_amount:'0',fee_atoms:'0',valid_to:now+3600,...patch};
}
function build(row,options={}) { return model.buildCounterOrder(row,{metadata,now,...options}); }
for(const c of cases) test(c.name,()=>{
  const row=fixture(c),r=build(row,{overlapBps:c.extraBps});
  assert.equal(r.enabled,true,r.reason);assert.equal(r.sellToken,row.buy_token);assert.equal(r.buyToken,row.sell_token);
  assert.equal(String(r.sellAtoms),c.counterSell);assert.equal(String(r.buyAtoms),c.counterBuy);
  assert(BigInt(row.signed_buy_atoms)*BigInt(r.buyAtoms)<=BigInt(row.signed_sell_atoms)*BigInt(r.sellAtoms));
});
test('signed ratio wins over rounded remaining and chart amounts',()=>{
  const r=build(fixture(cases[2],{remaining_sell_atoms:'1',remaining_buy_atoms:'3',normalized_price:'0.01',allocated_quote_atoms:'3'}));
  assert.equal(r.enabled,true,r.reason);assert.equal(String(r.sellAtoms),'4');assert.equal(String(r.buyAtoms),'1');
});
test('buy allocation caps target independently of funded sell',()=>{
  const r=build(fixture(cases[3],{allocated_buy_atoms:'0'}));assert.equal(r.enabled,false);
});
test('extra offer is additive and rounded upwards',()=>{
  const r=build(fixture(cases[2]),{overlapBps:1,extraSellAtoms:'2'});
  assert.equal(r.enabled,true,r.reason);assert.equal(String(r.sellAtoms),'7');assert.equal(String(r.buyAtoms),'1');
});
for(const [label,patch] of [
 ['unfunded',{allocated_sell_atoms:'0',funding_status:'not_allocated'}],
 ['conditional',{funding_status:'conditional'}],['expired',{valid_to:now-1}],
 ['partial FOK',{partially_fillable:false,funding_status:'partially_allocated',allocated_sell_atoms:'1'}],
 ['missing signed terms',{signed_sell_atoms:undefined}],['native counter sell',{buy_token:ETH}],
 ['negative allocation',{allocated_sell_atoms:'-1'}],['bad source kind',{kind:'other'}],['explicit fee',{fee_amount:'1',fee_atoms:'1'}]
]) test('disabled: '+label,()=>assert.equal(build(fixture(cases[0],patch)).enabled,false));
test('fully funded FOK is eligible',()=>assert.equal(build(fixture(cases[0],{partially_fillable:false})).enabled,true));
test('formats every atom without float or exponent',()=>{
 for(const [atoms,decimals,expected] of [['100000001',8,'1.00000001'],['1000001',6,'1.000001'],['1000000000000000001',18,'1.000000000000000001'],['1',18,'0.000000000000000001'],['0',18,'0']]) assert.equal(model.formatAtoms(atoms,decimals),expected);
});
test('URL prefills exact actual token amounts after hash',()=>{
 const r=build(fixture());const url=new URL(model.buildCowUrl(r));
 assert.equal(url.origin,'https://swap.cow.fi');assert.match(url.hash,new RegExp('^#/1/limit/'+USDC+'/'+WBTC+'\\?','i'));
 const q=new URLSearchParams(url.hash.split('?')[1]);assert.equal(q.get('sellAmount'),'100000');assert.equal(q.get('buyAmount'),'1');assert.equal(q.get('orderKind'),'sell');
 assert.deepEqual([...q.keys()].sort(),['buyAmount','orderKind','sellAmount']);
});
test('both protocol fees, fractional buffer and network are baked into URL',()=>{
 const row=fixture(cases[0],{signed_sell_atoms:'48312623277718519359765',signed_buy_atoms:'51694506908',allocated_sell_atoms:'48312623277718519359765',remaining_sell_atoms:'48312623277718519359765',remaining_buy_atoms:'51694506908',sell_token:WETH,buy_token:USDC});
 const r=build(row,{makerFeeBps:2,counterFeeBps:2,bufferBps:0.2,extraSellAtoms:'131918'});
 assert(r.enabled,r.reason);
 const ceil=(n,d)=>(n+d-1n)/d,base=51694506908n,network=131918n;
 const gross=ceil((base+network)*100000n**2n,99980n**2n);
 const expected=gross+ceil(gross*2n,100000n);
 assert.equal(r.sellAtoms,String(expected));
 assert.equal(BigInt(r.extraAtoms),network+BigInt(r.protocolAtoms)+BigInt(r.bufferAtoms));
 assert(BigInt(r.sellAtoms)>base+21000000n);
 const params=new URLSearchParams(new URL(r.url).hash.split('?')[1]);
 assert.equal(params.get('sellAmount'),r.sellAmount);
 assert.equal(r.buyAtoms,row.signed_sell_atoms);
});
test('invalid fee assumptions disable the draft',()=>{
 for(const options of [{makerFeeBps:-1},{counterFeeBps:10000},{bufferBps:0.25},{makerFeeBps:NaN}])assert.equal(build(fixture(),options).enabled,false);
});
