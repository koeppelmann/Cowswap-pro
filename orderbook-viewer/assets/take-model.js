(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CowProTake=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const ETH='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const ceil=(n,d)=>(n+d-1n)/d;
  function atoms(value){if(!/^\d+$/.test(String(value)))throw Error('Invalid integer amount');return BigInt(value);}
  function formatAtoms(value,decimals){const n=atoms(value);if(!Number.isInteger(decimals)||decimals<0||decimals>36)throw Error('Invalid decimals');if(!decimals)return n.toString();const s=n.toString().padStart(decimals+1,'0'),fraction=s.slice(-decimals).replace(/0+$/,'');return s.slice(0,-decimals)+(fraction?'.'+fraction:'');}
  function parseAtoms(value,decimals){const s=String(value).trim();if(!/^\d+(\.\d*)?$/.test(s))throw Error('Enter a nonnegative decimal amount');const [whole,fraction='']=s.split('.');if(fraction.length>decimals)throw Error('Too many decimal places');return(BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0')).toString();}
  function buildCowUrl(result){if(!result.enabled)return null;const q=new URLSearchParams({sellAmount:result.sellAmount,buyAmount:result.buyAmount,orderKind:'sell'});return 'https://swap.cow.fi/#/1/limit/'+result.sellToken+'/'+result.buyToken+'?'+q;}
  function buildCounterOrder(row,{metadata,overlapBps=0,extraSellAtoms='0',makerFeeBps=0,counterFeeBps=0,bufferBps=0,now=Date.now()/1000}){
    const no=reason=>({enabled:false,reason});
    try{
      if(row.signed_sell_atoms==null||row.signed_buy_atoms==null||!row.sell_token||!row.buy_token)return no('missing_terms');
      if(!Number.isFinite(Number(row.valid_to))||Number(row.valid_to)<=now)return no('expired');
      if(row.valid_from!=null&&Number(row.valid_from)>now)return no('not_yet_valid');
      if(!['sell','buy'].includes(row.kind))return no('unsupported_kind');
      if(row.funding_status==='conditional')return no('conditional_funding');
      const S=atoms(row.signed_sell_atoms),B=atoms(row.signed_buy_atoms),allocation=atoms(row.allocated_sell_atoms);
      if(S===0n||B===0n||allocation===0n)return no('unfunded');
      if(allocation>S)return no('invalid_allocation');
      if([row.signed_fee_atoms,row.fee_amount,row.fee_atoms].some(f=>f!=null&&atoms(f)!==0n))return no('explicit_fee_unsupported');
      if(row.partially_fillable===false&&(row.funding_status!=='fully_allocated'||allocation!==S||atoms(row.remaining_sell_atoms)!==S||atoms(row.remaining_buy_atoms)!==B))return no('incomplete_fok');
      const sellToken=row.buy_token.toLowerCase(),buyToken=row.sell_token.toLowerCase();
      if(sellToken===ETH)return no('native_eth_sell');
      if(sellToken===buyToken||!metadata[sellToken]||!metadata[buyToken])return no('unsupported_tokens');
      let sourceSell,sourceBuy;
      if(row.kind==='sell'){sourceSell=allocation;sourceBuy=ceil(sourceSell*B,S);}
      else{const buyAllocation=atoms(row.allocated_buy_atoms);sourceBuy=allocation*B/S;if(sourceBuy>buyAllocation)sourceBuy=buyAllocation;if(sourceBuy>B)sourceBuy=B;sourceSell=sourceBuy*S/B;}
      if(sourceSell===0n||sourceBuy===0n||sourceSell>allocation)return no('rounding_zero');
      if(!Number.isInteger(Number(overlapBps))||Number(overlapBps)<0||Number(overlapBps)>10000)return no('invalid_overlap');
      const bpsUnits=v=>{const n=Number(v);if(!Number.isFinite(n)||n<0||n>=10000||Math.abs(n*10-Math.round(n*10))>1e-7)throw Error('Invalid fee bps');return BigInt(Math.round(n*10));};
      const scale=100000n,maker=bpsUnits(makerFeeBps),counter=bpsUnits(counterFeeBps),buffer=bpsUnits(bufferBps);
      const network=atoms(extraSellAtoms),protocolBase=sourceBuy+network;
      const withProtocol=ceil(protocolBase*scale*scale,(scale-maker)*(scale-counter));
      const protocol=withProtocol-protocolBase,bufferAmount=ceil(withProtocol*buffer,scale);
      const extra=ceil(sourceBuy*BigInt(overlapBps),10000n)+network+protocol+bufferAmount,sell=sourceBuy+extra;
      if(B*sourceSell>S*sell)return no('incompatible_limits');
      const result={enabled:true,reason:null,sellToken,buyToken,sellAtoms:sell.toString(),buyAtoms:sourceSell.toString(),baseSellAtoms:sourceBuy.toString(),protocolAtoms:protocol.toString(),bufferAtoms:bufferAmount.toString(),networkAtoms:network.toString(),extraAtoms:extra.toString(),overlapBps:Number(overlapBps),sellAmount:formatAtoms(sell,metadata[sellToken].decimals),buyAmount:formatAtoms(sourceSell,metadata[buyToken].decimals)};
      result.url=buildCowUrl(result);return result;
    }catch{return no('invalid_amount');}
  }
  return{buildCounterOrder,formatAtoms,parseAtoms,buildCowUrl};
});
