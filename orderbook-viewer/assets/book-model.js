(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CowProBook=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function buildBook(rows,{includeUnfunded=false,search='',baseDecimals,depthUnit='usd',metadata,quoteRates}){
    const quoteValue=row=>Number(row.allocated_quote_atoms)/10**metadata[row.quote_token].decimals*Number(quoteRates[row.quote_token]);
    const funded=row=>BigInt(row.allocated_sell_atoms)>0n;
    const compare=(a,b,side)=>(Number(a.normalized_price)-Number(b.normalized_price))*(side==='bid'?-1:1)||a.uid.localeCompare(b.uid);
    const eligible=rows.filter(row=>funded(row)&&quoteValue(row)>=1);
    const bid=eligible.filter(row=>row.side==='bid').sort((a,b)=>compare(a,b,'bid'))[0];
    const ask=eligible.filter(row=>row.side==='ask').sort((a,b)=>compare(a,b,'ask'))[0];
    const bestBid=bid?Number(bid.normalized_price):null,bestAsk=ask?Number(ask.normalized_price):null;
    const mid=bid&&ask?(bestBid+bestAsk)/2:bid?bestBid:ask?bestAsk:null;
    const term=search.trim().toLowerCase();
    const matches=row=>!term||[row.owner,row.uid,row.quote_symbol,metadata[row.base_token]?.symbol,row.normalized_price].some(value=>String(value).toLowerCase().includes(term));
    function sideRows(side){
      let total=0;
      const values=rows.filter(row=>row.side===side&&(includeUnfunded||funded(row))).sort((a,b)=>compare(a,b,side)).map(order=>{
        const size=funded(order)?(depthUnit==='base'?Number(order.allocated_base_atoms)/10**baseDecimals:quoteValue(order)):0;
        total+=size;return{order,price:Number(order.normalized_price),size,total,depthPercent:0};
      });
      for(const row of values)row.depthPercent=total>0?Math.min(100,Math.max(0,row.total/total*100)):0;
      const filtered=values.filter(row=>matches(row.order));return side==='ask'?filtered.reverse():filtered;
    }
    return{asks:sideRows('ask'),bids:sideRows('bid'),mid,bestBid,bestAsk,midSource:bid&&ask?'both':bid?'bid':ask?'ask':'none',referenceOverlap:Boolean(bid&&ask&&bestBid>bestAsk&&(bid.quote_token!==ask.quote_token||bid.base_token!==ask.base_token))};
  }
  return{buildBook};
});
