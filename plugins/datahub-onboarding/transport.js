/** Browser RPC wire adapter; public payloads are the gateway's named args object. */
export async function callOnboardingRpc(connection, method, payload, signal) {
  const response = await connection.rpc.call(
    '/api',
    `datahubOnboarding/${method}`,
    { args: payload ?? {} },
    signal,
  );
  if (!response?.ok) throw new Error('RPC_FAILED');
  return response.value;
}
