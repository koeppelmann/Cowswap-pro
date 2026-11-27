"""Ethereum Keccak-256 (distinct from standardized SHA3-256)."""
from Crypto.Hash import keccak


def keccak256(value):
    digest = keccak.new(digest_bits=256)
    digest.update(value)
    return digest.digest()


def function_selector(signature):
    return keccak256(signature.encode())[:4]
