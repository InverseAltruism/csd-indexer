// A real mainnet header (block 32803): sha256d of its serialization meets the target of its bits, and it hashes to
// realTipHash (test/rpc-pow-route.test.ts checks both). The same vector as cairn's ROUTE-1 selftest.
export const realHeader = { version: 1, prev: "0x00000000000023001088ebb25d88a0657092d00129c76aaaa28a0f5dd5609095", merkle: "0xe0a002b0c98a8e64ecf2d7d2c2c1d6863b5dd9e03e6a3f22aaea6f03788cf5ef", time: 1781476758, bits: 453072620, nonce: 2749131683 };
export const realTipHash = "0x0000000000010c70c936f93ee4acbf76016d9c1f51dcffc78924d561bbcf4928";
