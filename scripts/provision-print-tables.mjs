import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

export function tableProvisionSql() {
  const now=new Date().toISOString();
  const rows=Array.from({length:7},(_,i)=>`(${i+1},'Table ${i+1}','${randomBytes(12).toString('base64url')}','AVAILABLE','${now}')`);
  // Keep the database's existing permanent token when a table already exists.
  return `INSERT INTO tables(display_number,name,permanent_qr_token,status,created_at) VALUES ${rows.join(',')} ON CONFLICT(display_number) DO NOTHING;`;
}
function query(sql) {
  const r=spawnSync('npx',['wrangler','d1','execute','224event-db','--remote','--json','--command',sql],{encoding:'utf8'});
  if(r.status!==0)throw new Error(`D1 operation failed: ${r.stderr}`);
  const result=JSON.parse(r.stdout);
  if(!result.every(x=>x.success!==false))throw new Error('D1 query did not succeed');
  return result.flatMap(x=>x.results??[]);
}
if(process.argv.includes('--apply')) {
  query(tableProvisionSql());
  const tables=query('SELECT display_number,permanent_qr_token FROM tables WHERE display_number BETWEEN 1 AND 7 ORDER BY display_number');
  assert.equal(tables.length,7);
  const cards=tables.map(t=>({tableNumber:t.display_number,url:`https://224event.bryank31172.workers.dev/t/${t.permanent_qr_token}`}));
  for(const card of cards) {
    const token=new URL(card.url).pathname.split('/').at(-1);
    const response=await fetch(`https://224event.bryank31172.workers.dev/api/public/table/${token}`);
    assert.equal(response.status,200);
    const data=await response.json();assert.equal(data.table.number,card.tableNumber);
    const page=await fetch(card.url,{redirect:'manual'});assert.equal(page.status,200);
  }
  writeFileSync('table-qr-cards.json',JSON.stringify(cards,null,2)+'\n');
  console.log('TABLE_QR_DATA='+JSON.stringify(cards));
  console.log('Verified all seven permanent table links against the live Worker.');
}
