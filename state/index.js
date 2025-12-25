import { MemoryState } from "./memory.js";
// import { RedisState } from "./redis.js";

const provider = process.env.STATE_PROVIDER || "memory";

let state;

if (provider === "memory") {
  state = new MemoryState();
}
// else if (provider === "redis") {
//   state = new RedisState();
// }

export default state;
