// osc-min publishes its types only through package.json "exports", which the
// "node" module resolution used here doesn't read.
declare module "osc-min" {
  export * from "osc-min/dist/index";
}
