// Loaded by Node before Pi starts so its tool subprocesses cannot inherit the key.
// Node's module cache retains the closure when Pi reloads its extensions.
const relayKey = process.env.NANO_RELAY_KEY;
const provider = process.env.NANO_RELAY_PROVIDER ?? "nano";
delete process.env.NANO_RELAY_KEY;
delete process.env.NANO_RELAY_PROVIDER;

if (!relayKey) throw new Error("The Nano relay key is missing.");
if (provider !== "nano" && !/^nano-external-[a-f0-9]{32}$/u.test(provider)) throw new Error("The Nano relay source is invalid.");

module.exports = (pi) => {
  pi.registerProvider(provider, { apiKey: relayKey });
};
