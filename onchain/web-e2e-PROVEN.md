# Frontend e2e (through the actual web routes, organic solver)
Opened Safe16 (0xFBfBa32F8aEAbC2c7386B21a1c247C56BB84E628). Drove a partial close (50%) through the
SAME routes the manage UI calls: /api/relay-execute (relays the owner-signed Retarget through
LevManagerModule.execute) + /api/barn (PUT appData, POST order). Organic solver filled it; collateral
and debt both exactly halved (14307779707405→7153890032479, 15018000371671917→7509000681398529).
