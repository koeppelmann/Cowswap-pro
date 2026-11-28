const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const assets=path.join(__dirname,'../assets');
const mainnet={key:'mainnet',chain_id:1,label:'Ethereum'},base={key:'base',chain_id:8453,label:'Base'};
function harness(){
  const nodes=new Map();
  const element=()=>({classList:{toggle(){},add(){}},parentElement:{classList:{toggle(){},add(){}}},value:'',textContent:'',inert:false,options:[],addEventListener(){},replaceChildren(){this.options=[];},append(...o){this.options.push(...o);if(!this.value&&o[0]&&o[0].value)this.value=o[0].value;}});
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},createElement:element,createTextNode:text=>({textContent:text})};
  const pending=[];
  const context={document,window:{},URLSearchParams,AbortController,setTimeout,clearTimeout,Date,console,location:{search:'?token=test&quote=SECOND'},fetch:(url,options)=>new Promise(resolve=>pending.push({url,options,resolve})),CowProTakeUI:{clearOrder(){}},history:{}};
  vm.createContext(context);
  let source=fs.readFileSync(path.join(assets,'depth.js'),'utf8');
  source=source.replace(/  start\(\)\.catch\([\s\S]*?\n\}\)\(\);\s*$/,`  resetSelection=()=>{};selectPair=()=>{$('market').value='first';};render=()=>{};updateURL=()=>{};applySnapshot=next=>{data=next;};
  window.test={loadNetwork,pollSnapshot,showOrder,showTwap,state:()=>({data,NET,transitioning,lastSnapshotId}),setNet:net=>{NET=net;}};
})();`);
  vm.runInContext(source,context);
  return {api:context.window.test,context,nodes,pending};
}
function book(auction){return {auction_id:auction,as_of_timestamp:1795687200,metadata:{first:{symbol:'FIRST'},second:{symbol:'SECOND'}},pairs:[{id:'test',label:'TEST',quote_modes:{first:{},second:{}}}]};}
function respond(request,body){request.resolve({ok:true,json:async()=>body});}
async function tick(){await new Promise(resolve=>setImmediate(resolve));}
async function finishLoad(h,net,auction,reset=true){const promise=h.api.loadNetwork(reset,net);const request=h.pending.findLast(r=>r.url===net.key+'/orderbook.json');respond(request,book(auction));await promise;}
test('delayed old network load cannot replace new data or counterorder chain',async()=>{
 const h=harness();h.api.setNet(mainnet);
 const old=h.api.loadNetwork(false,mainnet);const oldBook=h.pending.find(r=>r.url==='mainnet/orderbook.json');
 await finishLoad(h,base,2);
 respond(oldBook,book(1));await old;
 assert.equal(h.api.state().data.auction_id,2);assert.equal(h.context.window.CowProNet.chain_id,8453);
 const take=require(path.join(assets,'take-model.js'));
 assert.match(take.buildCowUrl({enabled:true,sellToken:'a',buyToken:'b',sellAmount:'1',buyAmount:'2'},h.context.window.CowProNet.chain_id),/#\/8453\/limit\//);
});
test('delayed poll response cannot overwrite the selected network',async()=>{
 const h=harness();h.api.setNet(mainnet);await finishLoad(h,mainnet,1);
 const poll=h.api.pollSnapshot();respond(h.pending.findLast(r=>r.url==='mainnet/status.json'),{snapshot_id:'old',last_success:Date.now()/1000,refresh_seconds:300});await tick();
 const oldBook=h.pending.findLast(r=>r.url.startsWith('mainnet/orderbook.json?v='));
 await finishLoad(h,base,2);respond(oldBook,book(99));await poll;
 assert.equal(h.api.state().data.auction_id,2);assert.equal(h.api.state().lastSnapshotId,null);
});
test('network transition keeps active chain until complete and freezes order detail',async()=>{
 const h=harness();h.api.setNet(mainnet);await finishLoad(h,mainnet,1);
 const next=h.api.loadNetwork(true,base);
 assert.equal(h.api.state().NET.key,'mainnet');assert.equal(h.api.state().transitioning,true);assert.equal(h.nodes.get('orderDetail').inert,true);
 h.api.showOrder('stale');h.api.showTwap('stale');
 assert.equal(h.nodes.has('takeOrder'),false);
 respond(h.pending.findLast(r=>r.url==='base/orderbook.json'),book(2));await next;
 assert.equal(h.api.state().NET.key,'base');assert.equal(h.nodes.get('orderDetail').inert,false);
});
test('nondefault quote deep link survives pair initialization',async()=>{
 const h=harness();h.api.setNet(mainnet);await finishLoad(h,mainnet,1,false);
 assert.equal(h.nodes.get('market').value,'second');
});
