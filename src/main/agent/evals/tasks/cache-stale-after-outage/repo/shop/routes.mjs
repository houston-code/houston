/** GET /products/:sku -> the product page's price block. */
export async function productPage(prices, sku) {
  try {
    const cents = await prices.price(sku)
    return { status: 200, body: `${sku}: $${(cents / 100).toFixed(2)}` }
  } catch (err) {
    return { status: 503, body: `${sku}: price unavailable (${err.message})` }
  }
}
