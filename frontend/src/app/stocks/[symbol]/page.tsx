import MarketCockpit from "@/components/MarketCockpit";

export default function StockPage({
  params,
}: {
  params: { symbol: string };
}) {
  const sym = decodeURIComponent(params.symbol || "NVDA").toUpperCase();
  return <MarketCockpit initialView="stock" initialStock={sym} />;
}
