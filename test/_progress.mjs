import { getMeta, db } from "../src/db.js";
const h = getMeta("indexed_height");
const b = db().prepare("SELECT COUNT(*) n, MAX(height) m FROM blocks").get();
const tip = (await (await fetch((process.env.CSD_RPC||"http://127.0.0.1:8790")+"/tip")).json()).height;
console.log(`indexed_height=${h} blocks=${b.n} max=${b.m} tip=${tip} (${((Number(h)/tip)*100).toFixed(1)}%)`);
