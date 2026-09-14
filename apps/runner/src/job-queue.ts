/** Bounded per-client round robin. Queue order is FIFO within one client.
 * This contains no timer or persistence: JobManager owns durable task state. */
export class FairJobQueue<T> {
  private readonly clients = new Map<string, Array<{id:string;value:T}>>();
  private turn: string | undefined;
  public constructor(readonly limit = 32, readonly perClient = 8) {
    if (!Number.isInteger(limit) || limit<0 || limit>1000 || !Number.isInteger(perClient) || perClient<1 || perClient>1000) throw new Error("Invalid queue limits");
  }
  public get size(): number { return [...this.clients.values()].reduce((n,q)=>n+q.length,0); }
  public count(client: string): number { return this.clients.get(client)?.length ?? 0; }
  public served(client: string): void { this.turn=client; }
  public push(client: string, id: string, value: T): void {
    if (this.size>=this.limit || this.count(client)>=this.perClient) throw new Error("queue_full");
    const q=this.clients.get(client)??[]; q.push({id,value}); this.clients.set(client,q);
  }
  public remove(id: string): void {
    for(const [client,q] of this.clients) { const i=q.findIndex(v=>v.id===id);if(i!==-1)q.splice(i,1);if(!q.length)this.clients.delete(client); }
  }
  public shift(): {id:string;value:T} | undefined {
    const keys=[...this.clients.keys()]; if(!keys.length)return undefined;
    const client=keys[0]===this.turn && keys.length>1 ? keys[1]! : keys[0]!;
    const q=this.clients.get(client)!;const item=q.shift();this.turn=client;
    // Move the served client to the back, preserving fairness when new clients arrive.
    this.clients.delete(client);if(q.length)this.clients.set(client,q);
    return item;
  }
}
