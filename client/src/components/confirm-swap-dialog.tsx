
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function ConfirmSwapDialog({ 
  open, 
  onOpenChange, 
  payAmount, 
  buyAmount, 
  leverage,
  ethPrice,
  debt,
  liquidationPrice,
  liquidationDrop,
  sellToken,
  buyToken
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payAmount: string;
  buyAmount: string;
  leverage: number;
  ethPrice: number;
  debt: string;
  liquidationPrice: string;
  liquidationDrop: number;
  sellToken: { symbol: string; icon: string };
  buyToken: { symbol: string; icon: string };
}) {
  const priceImpact = -0.13;
  const protocolFee = 0.000071;
  const networkCost = 0.000212;
  const slippage = 0.20;
  
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#0b0e1e] border-white/10 text-foreground sm:max-w-[480px] p-0 overflow-hidden gap-0">
        <DialogHeader className="px-6 py-4 border-b border-white/5 flex flex-row items-center justify-between">
          <DialogTitle className="text-lg font-medium flex items-center gap-2">
            Confirm Swap
            {leverage > 1 && (
                <span className="bg-primary/10 text-primary text-xs px-2 py-0.5 rounded-full font-mono">
                    {leverage}x Leverage
                </span>
            )}
          </DialogTitle>
        </DialogHeader>
        
        <div className="p-6 space-y-6">
            {/* Asset Cards */}
            <div className="flex items-center gap-2">
                <div className="flex-1 bg-[#12152b] rounded-2xl p-4 text-center space-y-2 border border-white/5">
                    <span className="text-xs text-muted-foreground block mb-1">Sell amount</span>
                    <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-sm font-bold text-white mx-auto overflow-hidden p-1">
                        <img src={sellToken.icon} alt={sellToken.symbol} className="w-full h-full object-contain" />
                    </div>
                    <div>
                        <div className="text-lg font-medium">{parseFloat(payAmount).toLocaleString()} {sellToken.symbol}</div>
                        <div className="text-xs text-muted-foreground">≈ ${parseFloat(payAmount).toLocaleString()}</div>
                    </div>
                </div>

                <div className="text-muted-foreground">→</div>

                <div className="flex-1 bg-[#12152b] rounded-2xl p-4 text-center space-y-2 border border-white/5 relative overflow-hidden">
                    {leverage > 1 && (
                        <div className="absolute top-0 right-0 bg-primary/20 text-primary text-[10px] font-bold px-2 py-0.5 rounded-bl-lg">
                            {leverage}x
                        </div>
                    )}
                    <span className="text-xs text-muted-foreground block mb-1">Receive (est.)</span>
                    <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center p-1 mx-auto overflow-hidden">
                        <img src={buyToken.icon} alt={buyToken.symbol} className="w-full h-full object-contain" />
                    </div>
                    <div>
                        <div className="text-lg font-medium text-primary">{buyAmount} {buyToken.symbol}</div>
                        <div className="text-xs text-muted-foreground">
                            ≈ ${(parseFloat(payAmount) * leverage).toLocaleString()} <span className="text-red-400">({priceImpact}%)</span>
                        </div>
                    </div>
                </div>
            </div>
            
            {/* Leverage Details Section */}
            {leverage > 1 && (
                <div className="bg-orange-500/5 border border-orange-500/20 rounded-xl p-4 space-y-3">
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Debt (Aave V3)</span>
                        <span className="font-mono text-orange-400 font-medium">{debt}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Deleverage Price</span>
                        <div className="text-right">
                             <span className="font-mono text-red-400 font-medium block">{liquidationPrice}</span>
                             <span className="text-[10px] text-muted-foreground">(-{liquidationDrop.toFixed(2)}%)</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Standard Details */}
            <div className="space-y-3 text-sm">
                <div className="flex justify-between text-muted-foreground">
                    <span>Price</span>
                    <span className="text-foreground">1 {buyToken.symbol} = {ethPrice.toFixed(2)} {sellToken.symbol}</span>
                </div>
                
                <div className="flex justify-between text-muted-foreground">
                    <span>Protocol fee (0.02%)</span>
                    <span className="text-foreground">{protocolFee} {buyToken.symbol} (≈ $0.2)</span>
                </div>

                <div className="flex justify-between text-muted-foreground">
                    <span>Network costs (est.)</span>
                    <span className="text-foreground">{networkCost} {buyToken.symbol} + gas (≈ $0.6)</span>
                </div>
                
                <Separator className="bg-white/10 my-2" />
                
                <div className="flex justify-between font-medium">
                    <span className="text-muted-foreground">Expected to receive</span>
                    <span>{buyAmount} {buyToken.symbol}</span>
                </div>

                <div className="flex justify-between text-muted-foreground mt-4 pt-2 border-t border-white/5">
                    <span>Slippage tolerance</span>
                    <span>{slippage.toFixed(2)}%</span>
                </div>
                
                <div className="flex justify-between font-medium">
                    <span className="text-muted-foreground">Minimum receive</span>
                    <span>{(parseFloat(buyAmount) * (1 - slippage/100)).toFixed(6)} {buyToken.symbol}</span>
                </div>
            </div>

            <Button className="w-full h-12 text-lg font-semibold rounded-xl bg-primary hover:bg-primary/90 shadow-lg shadow-primary/20">
                Confirm Swap
            </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
