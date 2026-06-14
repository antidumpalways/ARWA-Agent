import { TransactionV1 } from 'casper-js-sdk';

const txJson = {
  hash: '1f874ad188096a3be6fe008b461310b33b969807dcbf51ec6c5b741e3881ee24',
  payload: {
    initiator_addr: { PublicKey: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa' },
    timestamp: '2026-06-13T14:25:22.944Z',
    ttl: '30m',
    pricing_mode: { PaymentLimited: { gas_price_tolerance: 1, payment_amount: 30000000000, standard_payment: true } },
    chain_name: 'casper-test',
    fields: { args: { Named: [] } }
  },
  approvals: []
};

try {
  console.log('Creating TransactionV1 from JSON...');
  const tx = TransactionV1.fromJSON(txJson);
  console.log('Success! Transaction created');
  console.log('Hash:', tx.hash?.toHex?.() || 'no hash');
} catch (e: any) {
  console.log('Error:', e.message);
  console.log('Stack:', e.stack?.split('\n').slice(0, 5).join('\n'));
}
