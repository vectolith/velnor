import type { IdeFile } from "./workspace";
import { analyzeWorkspace } from "./inventory";
import { compareSnapshot, type WorkspaceSnapshot } from "./snapshots";
export type ChangePreflight = { added:string[]; removed:string[]; changed:string[]; findings:Array<{severity:"warning"|"info";message:string;files?:string[]}>; totalBytes:number; fileCount:number };
export function buildChangePreflight(files:IdeFile[],snapshot:WorkspaceSnapshot):ChangePreflight {
 const diff=compareSnapshot(snapshot,{files,entry:snapshot.entry,activeId:snapshot.activeId});
 const inventory=analyzeWorkspace(files); const changed=new Set([...diff.added,...diff.changed]); const findings:ChangePreflight["findings"]=[];
 if(diff.removed.length)findings.push({severity:"warning",message:"Files were removed; verify imports and references.",files:diff.removed});
 if(diff.changed.length)findings.push({severity:"info",message:"Modified files require review before execution or release.",files:diff.changed});
 if(diff.added.length)findings.push({severity:"info",message:"New files require review before execution or release.",files:diff.added});
 for(const observation of inventory.observations){const relevant=observation.files?.filter(path=>changed.has(path));if(!observation.files||relevant?.length)findings.push({severity:observation.severity,message:observation.message,files:relevant});}
 return {added:diff.added,removed:diff.removed,changed:diff.changed,findings,totalBytes:inventory.totalBytes,fileCount:inventory.fileCount};
}
