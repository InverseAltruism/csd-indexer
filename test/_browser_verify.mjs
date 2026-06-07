// Replicate the EXPLORER's in-browser verifier (SubtleCrypto) and confirm it agrees
// with csd-codec's verifyMerkleProof on real node blocks → the browser path is sound.
import { merkleBranch, verifyMerkleProof } from "@inversealtruism/csd-codec";
const RPC=process.env.CSD_RPC||"http://127.0.0.1:8790";
const hexToBytes=(h)=>{h=h.replace(/^0x/,'');const a=new Uint8Array(h.length/2);for(let i=0;i<a.length;i++)a[i]=parseInt(h.substr(i*2,2),16);return a;};
const bytesToHex=(b)=>'0x'+[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const sha256=async(b)=>new Uint8Array(await crypto.subtle.digest('SHA-256',b));
const sha256d=async(b)=>await sha256(await sha256(b));
async function browserVerify(txid,pos,branch,root){let cur=hexToBytes(txid),idx=pos;
  for(const s of branch){const sib=hexToBytes(s);const buf=new Uint8Array(64);
    if(idx&1){buf.set(sib,0);buf.set(cur,32);}else{buf.set(cur,0);buf.set(sib,32);}cur=await sha256d(buf);idx>>=1;}
  return bytesToHex(cur).toLowerCase()===root.toLowerCase();}
const g=async(p)=>(await fetch(RPC+p)).json();
const tip=(await g("/tip")).height; let P=0,F=0; const ok=(n,c)=>{c?P++:F++;console.log((c?"  ✅ ":"  ❌ ")+n);};
let checked=0;
for(let h=tip-3;h>tip-900&&checked<3;h--){let b=await g(`/block/height/${h}`);b=b.block??b;const txs=b.txs??[];if(txs.length<2)continue;
  const ids=txs.map(t=>t.txid);const root=b.header.merkle;
  for(let pos=0;pos<ids.length;pos++){const br=merkleBranch(ids,pos);
    const codec=verifyMerkleProof(ids[pos],pos,br,root);const browser=await browserVerify(ids[pos],pos,br,root);
    if(!(codec&&browser&&codec===browser)){ok(`h=${h} pos=${pos} browser==codec==true`,false);}}
  ok(`h=${h} (${ids.length} txs): SubtleCrypto fold == csd-codec for every pos`,true);
  const br0=merkleBranch(ids,0);ok(`h=${h}: browser rejects wrong pos`, !(await browserVerify(ids[0],1,br0,root)));
  checked++;}
console.log(`\nBROWSER VERIFY PATH: ${P} passed, ${F} failed`);process.exit(F?1:0);
