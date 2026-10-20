import { openStore } from "../src/store.ts";
import { defineStateSuite } from "./suite.ts";

defineStateSuite({
  name: "sqlite :memory:",
  fresh: (clock) => openStore({ url: "sqlite::memory:", clock }),
});
