(function(){
  'use strict';
  const $=id=>document.getElementById(id),M=window.DfusionTake,cache=new Map();
  let row=null,metadata=null,controller=null,reserveVersion=0,cooldown=0,lastRequest=0,requestEpoch=0;
  const reasons={missing_terms:'Waiting for refreshed signed terms',expired:'Order has expired',not_yet_valid:'Order is not valid yet',conditional_funding:'Funding depends on unverified hooks',unfunded:'No funded amount available',incomplete_fok:'Full-fill order is not fully funded',native_eth_sell:'Counter-order would sell native ETH. Wrap to WETH and review separately in CoW.',explicit_fee_unsupported:'Explicit signed fees need separate review',rounding_zero:'Funded amount is too small',invalid_overlap:'Use whole basis points from 0 to 10000',invalid_amount:'Check amount precision',unsupported_tokens:'Token metadata unavailable',incompatible_limits:'Counter limit does not overlap the signed limit'};
  function model(){if(!row)return{enabled:false,reason:'unfunded'};try{const sell=row.buy_token?.toLowerCase();return M.buildCounterOrder(row,{metadata,overlapBps:Number($('takeOverlap').value),makerFeeBps:Number($('takeMakerFee').value),counterFeeBps:Number($('takeCounterFee').value),bufferBps:Number($('takeBuffer').value),extraSellAtoms:sell?M.parseAtoms($('takeReserve').value||'0',metadata[sell].decimals):'0',chainId:(window.DfusionNet&&window.DfusionNet.chain_id)||1});}catch{return{enabled:false,reason:'invalid_amount'};}}
  function render(){
    const value=model();$('takeOpen').removeAttribute('href');$('takeOpen').setAttribute('aria-disabled',String(!value.enabled));
    $('takeError').textContent=value.enabled?'':reasons[value.reason]||'Order cannot be prepared';
    if(!value.enabled){$('takeSell').textContent='—';$('takeBuy').textContent='—';return value;}
    $('takeSell').textContent=value.sellAmount+' '+metadata[value.sellToken].symbol;$('takeBuy').textContent=value.buyAmount+' '+metadata[value.buyToken].symbol;
    $('takeReserveLabel').textContent='Network allowance · '+metadata[value.sellToken].symbol;
    $('takeBase').textContent=M.formatAtoms(value.baseSellAtoms,metadata[value.sellToken].decimals)+' '+metadata[value.sellToken].symbol;
    $('takeOpen').href=value.url;$('takeOpen').textContent=BigInt(value.extraAtoms)===0n?'Open zero-overlap order ↗':'Open in CoW Swap ↗';
    $('takeRoom').textContent=BigInt(value.extraAtoms)===0n?'Zero allowance for costs':'Extra offered '+M.formatAtoms(value.extraAtoms,metadata[value.sellToken].decimals)+' '+metadata[value.sellToken].symbol;
    const decimals=metadata[value.sellToken].decimals,symbol=metadata[value.sellToken].symbol;
    $('takeBreakdown').textContent='Protocol allowance '+M.formatAtoms(value.protocolAtoms,decimals)+' '+symbol+' · Buffer '+M.formatAtoms(value.bufferAtoms,decimals)+' '+symbol+' · Network '+M.formatAtoms(value.networkAtoms,decimals)+' '+symbol;
    const buyDecimals=metadata[value.buyToken].decimals,precision=10n**10n;
    const price=BigInt(value.sellAtoms)*10n**BigInt(buyDecimals)*precision/(BigInt(value.buyAtoms)*10n**BigInt(decimals));
    $('takePrice').textContent='Counter limit: '+M.formatAtoms(price.toString(),10)+' '+symbol+' / '+metadata[value.buyToken].symbol;
    $('takeRoom').classList.toggle('warning',BigInt(value.extraAtoms)===0n);return value;
  }
  async function estimate(){
    const value=render();if(!value.enabled)return;const key=value.sellToken+':'+value.buyToken+':'+value.buyAtoms;
    const apply=quote=>{const current=model();if(!row||row.uid!==uid||!current.enabled||current.buyAtoms!==value.buyAtoms||current.sellToken!==value.sellToken||current.buyToken!==value.buyToken)return;$('takeFeeStatus').textContent='Indicative quote fee '+M.formatAtoms(quote.feeAtoms,metadata[value.sellToken].decimals)+' '+metadata[value.sellToken].symbol;
      $('takeFeeStatus').title='Public zero-address market quote, not the actual cost or fee policies of matching both orders. Network allowance defaults to 2× this estimate; protocol allowances and buffer are added separately. Final wallet-specific fees and limit price must be reviewed in CoW.';
      if(version===reserveVersion){$('takeReserve').value=M.formatAtoms((2n*BigInt(quote.feeAtoms)).toString(),metadata[value.sellToken].decimals);render();}};
    const uid=row.uid,version=reserveVersion,existing=cache.get(key);
    if(existing&&existing.expires>Date.now()){apply(existing);return;}
    if(Date.now()<cooldown){$('takeFeeStatus').textContent='Fee service cooling down · enter extra amount';return;}
    if(Date.now()-lastRequest<1500){$('takeFeeStatus').textContent='Fee estimate paused · retry shortly';return;}
    const requestId=++requestEpoch;controller?.abort();controller=new AbortController();const requestController=controller,signal=requestController.signal;lastRequest=Date.now();$('takeEstimate').disabled=true;$('takeFeeStatus').textContent='Estimating network fee…';
    const timer=setTimeout(()=>requestController.abort(),20000);
    try{
      const response=await fetch('https://api.cow.fi/'+((window.DfusionNet&&window.DfusionNet.slug)||'mainnet')+'/api/v1/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sellToken:value.sellToken,buyToken:value.buyToken,kind:'buy',buyAmountAfterFee:value.buyAtoms,from:'0x0000000000000000000000000000000000000000',priceQuality:'optimal'}),signal});
      if(!response.ok){if([403,429,503].includes(response.status)){const retry=Number(response.headers.get('Retry-After'));cooldown=Date.now()+Math.max(60000,Number.isFinite(retry)?retry*1000:0);}throw Error('quote_unavailable');}
      const body=await response.json(),q=body.quote;const expiry=Date.parse(body.expiration||q?.validTo&&new Date(q.validTo*1000).toISOString());
      if(!q||q.sellToken?.toLowerCase()!==value.sellToken||q.buyToken?.toLowerCase()!==value.buyToken||!/^\d+$/.test(q.feeAmount)||!Number.isFinite(expiry)||expiry<=Date.now())throw Error('invalid_quote');
      const quote={feeAtoms:q.feeAmount,expires:Math.min(expiry,Date.now()+60000)};cache.set(key,quote);if(cache.size>100)cache.delete(cache.keys().next().value);apply(quote);
    }catch{if(requestId!==requestEpoch)return;if(row?.uid===uid&&!signal.aborted)$('takeFeeStatus').textContent='Fee unavailable · enter your reserve';else if(row?.uid===uid)$('takeFeeStatus').textContent='Fee estimate timed out · enter extra amount';}
    finally{clearTimeout(timer);if(requestId===requestEpoch)$('takeEstimate').disabled=false;}
  }
  function clearOrder(){requestEpoch++;controller?.abort();$('takeEstimate').disabled=false;row=null;metadata=null;$('takePanel').hidden=true;$('takeOrder').disabled=true;}
  function selectOrder(next,meta){
    const changed=row?.uid!==next.uid;row=next;metadata=meta;
    if(changed){requestEpoch++;controller?.abort();$('takeEstimate').disabled=false;reserveVersion++;$('takeOverlap').value='0';$('takeMakerFee').value='2';$('takeCounterFee').value='2';$('takeBuffer').value='0.2';$('takeReserve').value='0';$('takeFeeStatus').textContent='Indicative fee estimate not requested';$('takePanel').hidden=true;}
    const initial=M.buildCounterOrder(row,{metadata});$('takeOrder').disabled=!initial.enabled;$('takeOrder').title=initial.enabled?'Prepare the opposite limit order using actual tokens and funded size':reasons[initial.reason]||'Order cannot be prepared';
    if(!$('takePanel').hidden)render();
  }
  $('takeOrder').addEventListener('click',()=>{$('takePanel').hidden=false;render();estimate();});
  for(const id of ['takeOverlap','takeMakerFee','takeCounterFee','takeBuffer'])$(id).addEventListener('input',render);$('takeReserve').addEventListener('input',()=>{reserveVersion++;render();});$('takeEstimate').addEventListener('click',estimate);
  $('takeOpen').addEventListener('click',event=>{const result=render();if(!result.enabled)event.preventDefault();});
  window.DfusionTakeUI={selectOrder,clearOrder};
})();
