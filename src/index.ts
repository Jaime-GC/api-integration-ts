import { ProductsClient } from "./client.js";

const client = new ProductsClient();
const products = await client.getAll(30);
const sum = products.reduce((acc, p) => acc + p.price, 0);

console.log(`Products fetched: ${products.length}`);
console.log(`Sum of prices: ${sum.toFixed(2)}`);
