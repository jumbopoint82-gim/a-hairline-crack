import worker from "./index";
import { createReadReliableFetch } from "./read-reliability";

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = createReadReliableFetch(nativeFetch);

export default worker;
