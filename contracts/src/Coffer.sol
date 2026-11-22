// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// Coffer on QoreChain: two public records, both written only with an
/// ML-DSA-87 signature that the chain itself checks.
///
/// 1. Cards. A QoreSeal recipient card ties an account to the encryption keys
///    anyone may seal to (ML-KEM-1024 + X25519). Wallets like QoreX cannot put
///    an encryption key in the chain's KEM registry, but they can sign a card.
///    The contract rebuilds the exact card text, reads the account's ML-DSA-87
///    key from the chain (0x0A02, proof of possession required) and verifies
///    the signature (0x0A01). The newest card per account wins, so a lost
///    device's key can be replaced and an old card cannot come back.
///
/// 2. Heads. Each sealed file has one owner and an epoch that only goes up.
///    The owner signs every change of who can read it; the contract checks
///    that signature and refuses an older epoch or a different owner. Readers
///    compare a file against its head, so an old copy (with a removed reader
///    still in it) or a copy from someone else is refused.
///
/// Nothing here trusts msg.sender: anyone may submit, only signatures count.
contract Coffer {
    address internal constant VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant STATUS = 0x0000000000000000000000000000000000000a02;
    uint256 internal constant MLKEM_1024_PUBLIC_KEY_LENGTH = 1568;
    uint256 internal constant MAX_NOTE = 1024;

    /// The Cosmos chain id the signatures are bound to, e.g. "qorechain-diana".
    string public chainId;

    struct Card {
        bytes32 mlkemSha3; // SHA3-256 of the ML-KEM-1024 public key
        bytes32 x25519; // X25519 public key
        bytes32 issuedAt; // "YYYY-MM-DDTHH:MM:SSZ", left aligned (compares in time order)
        uint64 height; // block of the CardSet event that carries the full key
    }

    struct Head {
        address owner;
        uint64 epoch;
        uint64 version;
        uint64 height; // block of the HeadSet event
        bytes32 access; // SHA3-256 of the file's access block
        bytes32 data; // SHA3-256 of the sealed contents at that version
    }

    mapping(address => Card) public cards;
    mapping(bytes16 => Head) public heads;

    event CardSet(
        address indexed account, bytes32 mlkemSha3, bytes32 x25519, string issuedAt, bytes mlkemKey, bytes card
    );
    event HeadSet(
        bytes16 indexed file, address indexed owner, uint64 epoch, uint64 version, bytes32 access, bytes32 data, string note
    );

    error NoProvenKey(address account);
    error BadSignature();
    error BadIssuedAt();
    error StaleCard();
    error BadKeyLength();
    error NotOwner(address owner);
    error StaleEpoch(uint64 current);
    error NoteTooLong();
    error PrecompileInactive();

    constructor(string memory chainId_) {
        chainId = chainId_;
    }

    // ---- cards ---------------------------------------------------------------

    /// Publish or replace an account's recipient card. `pqSig` is the ML-DSA-87
    /// part of the account's QoreSign message signature over the card text;
    /// `card` is the full card JSON (both signatures) for readers who check it
    /// again off chain.
    function setCard(
        address account,
        bytes32 mlkemSha3,
        bytes32 x25519,
        string calldata issuedAt,
        bytes calldata pqSig,
        bytes calldata mlkemKey,
        bytes calldata card
    ) external {
        bytes32 t = _issuedAt(issuedAt);
        if (t <= cards[account].issuedAt) revert StaleCard();
        if (mlkemKey.length != MLKEM_1024_PUBLIC_KEY_LENGTH) revert BadKeyLength();
        _verify(account, cardText(account, mlkemSha3, x25519, issuedAt), pqSig);
        cards[account] = Card(mlkemSha3, x25519, t, uint64(block.number));
        emit CardSet(account, mlkemSha3, x25519, issuedAt, mlkemKey, card);
    }

    /// The exact text a QoreSeal recipient card v1 signs (qoreseal recipientCardText).
    function cardText(address account, bytes32 mlkemSha3, bytes32 x25519, string calldata issuedAt)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            "QoreSeal recipient card v1\nChain ID: ",
            chainId,
            "\nAddress: ",
            bech32(account),
            "\nML-KEM-1024 key SHA3-256: ",
            _hex(abi.encodePacked(mlkemSha3)),
            "\nX25519 key: ",
            _hex(abi.encodePacked(x25519)),
            "\nIssued at: ",
            issuedAt
        );
    }

    // ---- heads ---------------------------------------------------------------

    /// Record a change of who can read `file`, signed by its owner. The first
    /// head binds the file to its owner; every later one must come from the
    /// same owner with a higher epoch.
    function setHead(
        bytes16 file,
        address owner,
        uint64 epoch,
        uint64 version,
        bytes32 access,
        bytes32 data,
        string calldata note,
        bytes calldata pqSig
    ) external {
        if (bytes(note).length > MAX_NOTE) revert NoteTooLong();
        Head memory h = heads[file];
        if (h.owner != address(0)) {
            if (h.owner != owner) revert NotOwner(h.owner);
            if (epoch <= h.epoch) revert StaleEpoch(h.epoch);
        }
        _verify(owner, changeText(file, epoch, version, access, data, note), pqSig);
        heads[file] = Head(owner, epoch, version, uint64(block.number), access, data);
        emit HeadSet(file, owner, epoch, version, access, data, note);
    }

    /// The exact text an owner signs for a change. The note (file name, readers)
    /// is for the person signing; the lines before it are what the chain checks.
    function changeText(bytes16 file, uint64 epoch, uint64 version, bytes32 access, bytes32 data, string calldata note)
        public
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            "Coffer change v1\nFile: ",
            _hex(abi.encodePacked(file)),
            "\nEpoch: ",
            _dec(epoch),
            "\nVersion: ",
            _dec(version),
            "\nAccess: ",
            _hex(abi.encodePacked(access)),
            "\nData: ",
            _hex(abi.encodePacked(data)),
            "\n",
            note
        );
    }

    // ---- signatures ----------------------------------------------------------

    /// The account's registered ML-DSA-87 key, only if its possession was proven.
    function provenKey(address account) public view returns (bytes memory key) {
        (bool ok, bytes memory ret) = STATUS.staticcall(abi.encodeWithSignature("pqcKeyStatus(address)", account));
        if (!ok || ret.length < 128) revert PrecompileInactive();
        (bool registered, uint8 alg, bytes memory pk, bool proven) = abi.decode(ret, (bool, uint8, bytes, bool));
        if (!registered || alg != 1 || !proven) revert NoProvenKey(account);
        return pk;
    }

    /// QoreSign message signing v1: ML-DSA-87 over "qorechain-msg-v1|" + chainId + "|" + text.
    function _verify(address account, bytes memory text, bytes calldata pqSig) internal view {
        bytes memory signed = abi.encodePacked("qorechain-msg-v1|", chainId, "|", text);
        (bool ok, bytes memory ret) =
            VERIFY.staticcall(abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", provenKey(account), pqSig, signed));
        if (!ok || ret.length < 32) revert PrecompileInactive();
        if (!abi.decode(ret, (bool))) revert BadSignature();
    }

    // ---- encoding ------------------------------------------------------------

    /// "YYYY-MM-DDTHH:MM:SSZ" only, so byte order is time order.
    function _issuedAt(string calldata s) internal pure returns (bytes32 t) {
        bytes calldata b = bytes(s);
        if (b.length != 20) revert BadIssuedAt();
        for (uint256 i; i < 20; ++i) {
            bytes1 c = b[i];
            bool ok;
            if (i == 4 || i == 7) ok = c == "-";
            else if (i == 10) ok = c == "T";
            else if (i == 13 || i == 16) ok = c == ":";
            else if (i == 19) ok = c == "Z";
            else ok = c >= "0" && c <= "9";
            if (!ok) revert BadIssuedAt();
        }
        t = bytes32(b);
    }

    function _hex(bytes memory b) internal pure returns (bytes memory out) {
        bytes16 digits = "0123456789abcdef";
        out = new bytes(b.length * 2);
        for (uint256 i; i < b.length; ++i) {
            out[2 * i] = digits[uint8(b[i]) >> 4];
            out[2 * i + 1] = digits[uint8(b[i]) & 15];
        }
    }

    function _dec(uint64 v) internal pure returns (bytes memory) {
        if (v == 0) return "0";
        bytes memory buf = new bytes(20);
        uint256 n;
        while (v > 0) {
            buf[19 - n] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
            ++n;
        }
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) out[i] = buf[20 - n + i];
        return out;
    }

    /// The account's qor1 address (bech32, BIP-173).
    function bech32(address account) public pure returns (bytes memory) {
        bytes memory charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
        uint160 a = uint160(account);
        uint8[32] memory d;
        for (uint256 i; i < 32; ++i) d[31 - i] = uint8((a >> (5 * i)) & 31);
        // polymod over hrp "qor" expanded, the data, and six zeros
        uint32 chk = 1;
        bytes3 hrp = "qor";
        for (uint256 i; i < 3; ++i) chk = _polymod(chk, uint8(hrp[i]) >> 5);
        chk = _polymod(chk, 0);
        for (uint256 i; i < 3; ++i) chk = _polymod(chk, uint8(hrp[i]) & 31);
        for (uint256 i; i < 32; ++i) chk = _polymod(chk, d[i]);
        for (uint256 i; i < 6; ++i) chk = _polymod(chk, 0);
        chk ^= 1;
        bytes memory out = new bytes(42);
        out[0] = "q";
        out[1] = "o";
        out[2] = "r";
        out[3] = "1";
        for (uint256 i; i < 32; ++i) out[4 + i] = charset[d[i]];
        for (uint256 i; i < 6; ++i) out[36 + i] = charset[(chk >> (5 * (5 - i))) & 31];
        return out;
    }

    function _polymod(uint32 chk, uint8 v) private pure returns (uint32) {
        uint32 top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        if (top & 1 != 0) chk ^= 0x3b6a57b2;
        if (top & 2 != 0) chk ^= 0x26508e6d;
        if (top & 4 != 0) chk ^= 0x1ea119fa;
        if (top & 8 != 0) chk ^= 0x3d4233dd;
        if (top & 16 != 0) chk ^= 0x2a1462b3;
        return chk;
    }
}
