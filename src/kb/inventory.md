# TallyDekho — Inventory & Stock Management

## Viewing Stock
- Tap the Stocks tab from the bottom navigation
- Shows all stock items with closing quantity and value
- Filter by: stock group, warehouse, low stock, negative stock

## Stock Detail
- Tap any stock item to see:
  - Opening quantity and value
  - Current closing quantity and value
  - Recent transactions (purchases, sales, adjustments)
  - Batch details (if applicable)
  - Warehouse-wise breakdown

## Low Stock Alerts
- Items where closing_qty <= reorder_level show in the Low Stock view
- Critical items: closing_qty <= 0 (out of stock)
- Go to AI Insights → Stock-out Risk card to see all low stock items
- Set reorder levels in Tally Prime (syncs to TallyDekho automatically)

## Warehouses
- If you use godowns/warehouses in Tally, they appear in TallyDekho
- View warehouse-wise stock from the Stocks tab → Warehouse filter
- Each warehouse shows its own stock levels

## Negative Stock
- Items with negative closing_qty are flagged separately
- Usually caused by sales without purchase entry in Tally

## Stock Categories / Groups
- Stock items are organised by groups as defined in Tally
- Filter the stock list by group using the group filter

## Stock Valuation
- Values are shown at closing rate (as per Tally)
- Total stock value shown in dashboard KPI card

## Barcode / SKU
- If SKU/barcode is defined in Tally, it syncs to TallyDekho
- Not currently editable from mobile — update in Tally, resync

## Adjustments & Transfers
- Stock adjustments and transfers visible in stock transaction history
- Create adjustment voucher from Vouchers tab (Journal type)
