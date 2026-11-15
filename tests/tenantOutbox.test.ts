import assert from "node:assert/strict";
import test from "node:test";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/lib/storage/d1TenantState";
import {
  claimTenantAction, completeTenantAction, enqueueTenantAction, retryTenantAction
} from "../src/lib/storage/tenantOutbox";

type Row = {
  id:string; tenant_id:string; idempotency_key:string; action_type:string; payload_json:string;
  status:"pending"|"processing"|"delivered"|"dead"; attempts:number; available_at:string;
  lease_owner:string|null; lease_until:string|null; last_error:string|null; created_at:string; updated_at:string;
};
class FakeD1 implements D1Database {
  rows = new Map<string, Row>();
  prepare(query:string):D1PreparedStatement {
    const db=this; let values:unknown[]=[];
    return {
      bind(...args:unknown[]){values=args;return this;},
      async first<T>(){
        if(query.includes("WHERE tenant_id = ? AND idempotency_key = ?")){
          const row=[...db.rows.values()].find(x=>x.tenant_id===values[0]&&x.idempotency_key===values[1]);
          return (row?{...row}:null) as unknown as T|null;
        }
        if(query.includes("RETURNING status")){
          const [max,available,error,updated,tenant,id,worker]=values;
          const row=db.rows.get(String(id));
          if(!row||row.tenant_id!==tenant||row.status!=="processing"||row.lease_owner!==worker)return null;
          row.status=row.attempts>=Number(max)?"dead":"pending";row.available_at=String(available);
          row.lease_owner=null;row.lease_until=null;row.last_error=String(error);row.updated_at=String(updated);
          return {status:row.status} as unknown as T;
        }
        return null;
      },
      async all<T>():Promise<D1Result<T>>{
        if(query.includes("UPDATE tenant_outbox")&&query.includes("RETURNING *")){
          const [worker,leaseUntil,updated,tenant,subTenant,now,expired,expired2]=values;
          if(tenant!==subTenant)return {success:true,results:[]};
          const row=[...db.rows.values()].filter(x=>x.tenant_id===tenant&&x.available_at<=String(now)&&
            (x.status==="pending"||(x.status==="processing"&&Boolean(x.lease_until)&&x.lease_until!<=String(expired))))
            .sort((a,b)=>a.available_at.localeCompare(b.available_at)||a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id))[0];
          if(!row)return {success:true,results:[]};
          row.status="processing";row.lease_owner=String(worker);row.lease_until=String(leaseUntil);
          row.attempts++;row.updated_at=String(updated);
          return {success:true,results:[{...row} as unknown as T]};
        }
        return {success:true,results:[]};
      },
      async run():Promise<D1Result>{
        if(query.includes("INSERT INTO tenant_outbox")){
          const [id,tenant,key,action,payload,available,created,updated]=values as unknown[];
          if([...db.rows.values()].some(x=>x.tenant_id===tenant&&x.idempotency_key===key))return {success:true,meta:{changes:0}};
          db.rows.set(String(id),{id:String(id),tenant_id:String(tenant),idempotency_key:String(key),
            action_type:String(action),payload_json:String(payload),status:"pending",attempts:0,
            available_at:String(available),lease_owner:null,lease_until:null,last_error:null,
            created_at:String(created),updated_at:String(updated)});
          return {success:true,meta:{changes:1}};
        }
        if(query.includes("SET status = 'delivered'")){
          const [updated,tenant,id,worker]=values;const row=db.rows.get(String(id));
          if(!row||row.tenant_id!==tenant||row.status!=="processing"||row.lease_owner!==worker)return {success:true,meta:{changes:0}};
          row.status="delivered";row.lease_owner=null;row.lease_until=null;row.last_error=null;row.updated_at=String(updated);
          return {success:true,meta:{changes:1}};
        }
        return {success:true,meta:{changes:0}};
      }
    };
  }
}
const fixedNow=new Date("2026-11-14T12:00:00.000Z");
test("outbox enqueue is idempotent and tenant scoped",async()=>{
 const db=new FakeD1();const input={id:"item_a",tenantId:"tenant_a",idempotencyKey:"reminder:1",actionType:"slack.send",payload:{text:"hello"}};
 const a=await enqueueTenantAction(db,input);const b=await enqueueTenantAction(db,{...input,id:"item_b"});
 assert.equal(a.inserted,true);assert.equal(b.inserted,false);assert.equal(b.item.id,"item_a");
 await assert.rejects(()=>enqueueTenantAction(db,{...input,payload:{text:"different"}}),/different tenant action/);
 const other=await enqueueTenantAction(db,{...input,tenantId:"tenant_b"});assert.equal(other.inserted,true);
});
test("outbox claims due actions with tenant ownership and leases",async()=>{
 const db=new FakeD1();await enqueueTenantAction(db,{id:"a",tenantId:"tenant_a",idempotencyKey:"k1",actionType:"slack.send",payload:{text:"a"},availableAt:"2026-11-14T11:00:00.000Z"});
 await enqueueTenantAction(db,{id:"b",tenantId:"tenant_b",idempotencyKey:"k2",actionType:"slack.send",payload:{text:"b"},availableAt:"2026-11-14T11:00:00.000Z"});
 const claimed=await claimTenantAction(db,"tenant_a","worker_1",60_000,fixedNow);
 assert.equal(claimed?.id,"a");assert.equal(claimed?.attempts,1);assert.equal(claimed?.leaseOwner,"worker_1");
 assert.equal(await claimTenantAction(db,"tenant_a","worker_2",60_000,fixedNow),null);
});
test("expired leases can be reclaimed and stale workers cannot complete",async()=>{
 const db=new FakeD1();await enqueueTenantAction(db,{id:"a",tenantId:"tenant_a",idempotencyKey:"k1",actionType:"slack.send",payload:{},availableAt:"2026-11-14T11:00:00.000Z"});
 const first=await claimTenantAction(db,"tenant_a","worker_1",1_000,fixedNow);
 const second=await claimTenantAction(db,"tenant_a","worker_2",1_000,new Date(fixedNow.getTime()+2_000));
 assert.equal(second?.id,"a");assert.equal(second?.attempts,2);
 await assert.rejects(()=>completeTenantAction(db,"tenant_a","a","worker_1"),/not leased/);
 await completeTenantAction(db,"tenant_a","a","worker_2");
 assert.equal(db.rows.get("a")?.status,"delivered");
});
test("retry applies backoff and dead-letters exhausted actions",async()=>{
 const db=new FakeD1();await enqueueTenantAction(db,{id:"a",tenantId:"tenant_a",idempotencyKey:"k1",actionType:"slack.send",payload:{},availableAt:"2026-11-14T11:00:00.000Z"});
 await claimTenantAction(db,"tenant_a","worker_1",60_000,fixedNow);
 const retry=await retryTenantAction(db,"tenant_a","a","worker_1",{availableAt:"2026-11-14T12:05:00.000Z",error:"provider unavailable",maxAttempts:2,now:fixedNow});
 assert.equal(retry,"pending");
 const next=await claimTenantAction(db,"tenant_a","worker_2",60_000,new Date("2026-11-14T12:05:01.000Z"));
 assert.equal(next?.attempts,2);
 const dead=await retryTenantAction(db,"tenant_a","a","worker_2",{availableAt:"2026-11-14T12:10:00.000Z",error:"still unavailable",maxAttempts:2,now:fixedNow});
 assert.equal(dead,"dead");
});
test("outbox validates identifiers, payload size and lease bounds",async()=>{
 const db=new FakeD1();
 await assert.rejects(()=>enqueueTenantAction(db,{id:"bad id",tenantId:"tenant_a",idempotencyKey:"k",actionType:"slack.send",payload:{}}),/outbox item ID/);
 await assert.rejects(()=>enqueueTenantAction(db,{id:"a",tenantId:"tenant_a",idempotencyKey:"k",actionType:"slack.send",payload:{text:"x".repeat(70_000)}}),/64 KiB/);
 await assert.rejects(()=>claimTenantAction(db,"tenant_a","worker",500,fixedNow),/lease/);
});
