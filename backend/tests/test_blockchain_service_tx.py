import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.services import blockchain_service


class BlockchainServiceTxTests(unittest.TestCase):
    def test_raw_tx_builder_reserves_pending_nonce(self) -> None:
        built_transactions: list[dict] = []

        class FakeFunction:
            def build_transaction(self, base: dict) -> dict:
                built = dict(base)
                built_transactions.append(built)
                return built

        class FakeFunctions:
            def mintForIssuer(self, *args):  # noqa: N802 - mirrors contract ABI name
                return FakeFunction()

        account = MagicMock()
        account.address = "0x" + "1" * 40
        account.sign_transaction.return_value = SimpleNamespace(raw_transaction=b"raw")

        tx_hash = MagicMock()
        tx_hash.hex.return_value = "0xabc"

        w3 = MagicMock()
        w3.eth.get_transaction_count.return_value = 7
        w3.eth.chain_id = 80002
        w3.eth.get_block.return_value = {"baseFeePerGas": 100}
        w3.eth.max_priority_fee = 200
        w3.eth.estimate_gas.return_value = 100_000
        w3.eth.send_raw_transaction.return_value = tx_hash
        w3.eth.wait_for_transaction_receipt.return_value = {
            "status": 1,
            "transactionHash": tx_hash,
        }

        receipt = blockchain_service._build_and_send_raw_tx(
            w3,
            SimpleNamespace(functions=FakeFunctions()),
            account,
            "mintForIssuer",
            "issuer",
            "uri",
            b"hash",
            "cert",
        )

        self.assertEqual(receipt["status"], 1)
        w3.eth.get_transaction_count.assert_called_once_with(account.address, "pending")
        self.assertEqual(built_transactions[0]["nonce"], 7)
        w3.eth.send_raw_transaction.assert_called_once_with(b"raw")


if __name__ == "__main__":
    unittest.main()
