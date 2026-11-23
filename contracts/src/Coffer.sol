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
/// 2. Heads. Each sealed file has one owner, an epoch that only goes up and a
///    version that only goes up. The owner signs every change of who can read
///    it; a current reader signs every write of new contents. The contract
///    checks those signatures and refuses an older epoch or version, a
///    different owner, or a writer not on the current list. Readers compare a
///    file against its head, so an old copy or a copy from someone else is refused.
///
/// 3. Opens. Each version's contents need two pieces: the reader's own epoch
///    key (sealed to them in the file) and a release piece made for that
///    version only, which only the file's keeper can unwrap. To open, the
///    reader signs a request naming the file's current version and a reply key
///    made for this one open. The contract refuses it unless the reader is on
///    the file's current list and the version is the latest, then records the
///    open together with the release piece sealed to that reply key. The reply
///    key is thrown away after use, so the public record holds nothing that a
///    reader's long term key, or a stolen laptop, can open later.
///
/// Access control. Every state change is authorised by an ML-DSA-87 signature,
/// not by msg.sender: setCard and setDevice need the account's own signature,
/// setHead the file owner's, write a current reader's, open the reader's (or a
/// device the reader approved).
/// Each is verified on chain by the pqcVerify precompile against the key
/// QoreChain registered for that account with proof of possession (pqcKeyStatus).
/// So these functions are deliberately callable by anyone (a relayer pays the
/// gas), and a call without the right signature reverts with BadSignature,
/// NoProvenKey, NotOwner or NotReader. Submitting someone else's signed message
/// first only records exactly what they signed, so front-running gains nothing.
/// Arithmetic is checked (Solidity 0.8) and every loop is bounded (64 readers).
contract Coffer {
    address internal constant VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant STATUS = 0x0000000000000000000000000000000000000a02;
    uint256 internal constant MLKEM_1024_PUBLIC_KEY_LENGTH = 1568;
    uint256 internal constant MAX_NAME = 64;
    uint256 internal constant MAX_READERS = 64;
    uint256 internal constant MAX_FILE = 65536;
    uint256 internal constant ML_DSA_87_PUBLIC_KEY_LENGTH = 2592;
    uint256 internal constant MAX_RELEASE = 4096;
    /// A device approval lasts at most this many blocks (about 3 days at 1.4 s).
    uint64 internal constant MAX_DEVICE_BLOCKS = 200_000;

    /// The Cosmos chain id the signatures are bound to, e.g. "qorechain-diana".
    string public chainId;
    /// The site named in every change text ("Sign this only on <site>.").
    string public site;

    /// One change of who can read a file, as the owner signed it.
    struct Change {
        bytes16 file;
        address owner;
        uint64 epoch;
        uint64 version;
        bytes32 access;
        bytes32 data;
        string name;
        address[] readers; // every reader, the owner included, in ascending address order
    }

    /// New contents of a file under its current access block, as a current reader signed it.
    struct Write {
        bytes16 file;
        uint64 epoch;
        uint64 version;
        bytes32 access;
        bytes32 data;
        string name;
        address writer;
    }

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
    /// Every file an account was ever a reader of (owners included), oldest first.
    mapping(address => bytes16[]) internal _files;
    mapping(address => mapping(bytes16 => bool)) public listed;
    /// The last epoch an account was on a file's reader list. Equal to the head's epoch: a current reader.
    mapping(bytes16 => mapping(address => uint64)) public memberAt;
    /// Device keys an account approved: keccak256(ML-DSA-87 public key) => last block it may sign at.
    mapping(address => mapping(bytes32 => uint64)) public devices;
    /// Open request nonces already used, per reader.
    mapping(address => mapping(uint64 => bool)) public usedNonce;

    /// One recorded open: who, which epoch and version of the file, and when.
    struct OpenRecord {
        address reader;
        uint64 epoch;
        uint64 version;
        uint64 blockNumber;
    }
    mapping(bytes16 => OpenRecord[]) internal _opens;

    /// One request to open a file, signed by the reader or by one of its approved devices.
    /// `replyKey` is keccak256 of the ML-KEM-1024 and X25519 public keys made for this open only.
    struct OpenRequest {
        bytes16 file;
        uint64 epoch;
        uint64 version;
        address reader;
        bytes32 replyKey;
        uint64 nonce;
    }

    event CardSet(
        address indexed account, bytes32 mlkemSha3, bytes32 x25519, string issuedAt, bytes mlkemKey, bytes card
    );
    /// `sealedFile` is the whole .env.coffer after the change: readers fetch it from here.
    event HeadSet(
        bytes16 indexed file,
        address indexed owner,
        uint64 epoch,
        uint64 version,
        bytes32 access,
        bytes32 data,
        string name,
        bytes sealedFile
    );
    event DeviceSet(address indexed account, bytes32 indexed device, uint64 untilBlock);
    /// `release` is that version's release piece, sealed to the one time reply key (ciphertext).
    event Opened(
        bytes16 indexed file,
        address indexed reader,
        uint64 epoch,
        uint64 version,
        uint64 nonce,
        bytes32 device,
        bytes32 replyKey,
        bytes release
    );
    event Written(bytes16 indexed file, address indexed writer, uint64 version);

    error NoProvenKey(address account);
    error BadSignature();
    error BadIssuedAt();
    error StaleCard();
    error BadKeyLength();
    error NotOwner(address owner);
    error StaleEpoch(uint64 current);
    error BadName();
    error BadReaders();
    error BadFile();
    error PrecompileInactive();
    error BadEpoch();
    error NoHead();
    error NotReader(address reader);
    error UsedNonce();
    error DeviceNotApproved();
    error BadDevice();
    error BadRelease();
    error StaleVersion(uint64 current);
    error NotLatest(uint64 epoch, uint64 version);
    error BadAccess();
    error BadReplyKey();

    constructor(string memory chainId_, string memory site_) {
        chainId = chainId_;
        site = site_;
    }

    /// The files an account can find: shared with it now or before (it may have been removed since).
    function filesOf(address account) external view returns (bytes16[] memory) {
        return _files[account];
    }

    // ---- cards ---------------------------------------------------------------

    /// Publish or replace an account's recipient card. `pqSig` is the ML-DSA-87
    /// part of the account's QoreSign message signature over the card text;
    /// `card` is the full card JSON (both signatures) for readers who check it
    /// again off chain.
    /// @dev Access control: the account's ML-DSA-87 signature over the card text (see the contract notice).
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

    /// Record a change of who can read a file, signed by its owner, and deliver
    /// the sealed file to its readers. The first head binds the file to its
    /// owner; every later one must come from the same owner with a higher epoch.
    /// The reader list is part of the signed text, so the list each reader finds
    /// the file under is exactly the one the owner approved.
    /// @dev Access control: the owner's ML-DSA-87 signature over changeText; the first head binds the owner.
    function setHead(Change calldata c, bytes calldata sealedFile, bytes calldata pqSig) external {
        if (sealedFile.length == 0 || sealedFile.length > MAX_FILE) revert BadFile();
        if (c.epoch == 0) revert BadEpoch();
        Head memory h = heads[c.file];
        if (h.owner != address(0)) {
            if (h.owner != c.owner) revert NotOwner(h.owner);
            if (c.epoch <= h.epoch) revert StaleEpoch(h.epoch);
            if (c.version <= h.version) revert StaleVersion(h.version);
        }
        _verify(c.owner, changeText(c), pqSig);
        heads[c.file] = Head(c.owner, c.epoch, c.version, uint64(block.number), c.access, c.data);
        for (uint256 i; i < c.readers.length; ++i) {
            address r = c.readers[i];
            memberAt[c.file][r] = c.epoch;
            if (!listed[r][c.file]) {
                listed[r][c.file] = true;
                _files[r].push(c.file);
            }
        }
        emit HeadSet(c.file, c.owner, c.epoch, c.version, c.access, c.data, c.name, sealedFile);
    }

    /// The exact text an owner signs for a change: what the chain checks, then
    /// the file name and every reader in plain qor1 form, for the person signing.
    function changeText(Change calldata c) public view returns (bytes memory) {
        return abi.encodePacked(
            abi.encodePacked(
                "Coffer change v1\nFile: ",
                _hex(abi.encodePacked(c.file)),
                "\nEpoch: ",
                _dec(c.epoch),
                "\nVersion: ",
                _dec(c.version),
                "\nAccess: ",
                _hex(abi.encodePacked(c.access)),
                "\nData: ",
                _hex(abi.encodePacked(c.data))
            ),
            "\nName: ",
            _name(c.name),
            "\nCan open it: ",
            _readers(c.readers, c.owner),
            "\nSign this only on ",
            site,
            "."
        );
    }

    /// Record new contents of a file, written by a reader on its current list
    /// under the current access block (same epoch, same readers), and deliver
    /// the sealed file. The version must go up, so an older version cannot come back.
    /// @dev Access control: the writer's ML-DSA-87 signature over writeText, and memberAt == head epoch.
    function write(Write calldata w, bytes calldata sealedFile, bytes calldata pqSig) external {
        if (sealedFile.length == 0 || sealedFile.length > MAX_FILE) revert BadFile();
        Head memory h = heads[w.file];
        if (h.owner == address(0)) revert NoHead();
        if (w.epoch != h.epoch) revert StaleEpoch(h.epoch);
        if (w.access != h.access) revert BadAccess();
        if (w.version <= h.version) revert StaleVersion(h.version);
        if (memberAt[w.file][w.writer] != h.epoch) revert NotReader(w.writer);
        _verify(w.writer, writeText(w), pqSig);
        heads[w.file] = Head(h.owner, h.epoch, w.version, uint64(block.number), h.access, w.data);
        emit HeadSet(w.file, h.owner, h.epoch, w.version, h.access, w.data, w.name, sealedFile);
        emit Written(w.file, w.writer, w.version);
    }

    /// The exact text a reader signs to write new contents.
    function writeText(Write calldata w) public view returns (bytes memory) {
        return abi.encodePacked(
            abi.encodePacked(
                "Coffer write v2\nFile: ",
                _hex(abi.encodePacked(w.file)),
                "\nEpoch: ",
                _dec(w.epoch),
                "\nVersion: ",
                _dec(w.version),
                "\nAccess: ",
                _hex(abi.encodePacked(w.access)),
                "\nData: ",
                _hex(abi.encodePacked(w.data))
            ),
            "\nName: ",
            _name(w.name),
            "\nWriter: ",
            bech32(w.writer),
            "\nSign this only on ",
            site,
            "."
        );
    }

    /// 1 to 64 printable bytes, no line breaks, so the text cannot be read two ways.
    function _name(string calldata s) internal pure returns (string calldata) {
        bytes calldata b = bytes(s);
        if (b.length == 0 || b.length > MAX_NAME) revert BadName();
        for (uint256 i; i < b.length; ++i) if (uint8(b[i]) < 0x20 || uint8(b[i]) == 0x7f) revert BadName();
        return s;
    }

    /// "qor1…, qor1…" in ascending address order; the owner must be one of them.
    function _readers(address[] calldata rs, address owner) internal pure returns (bytes memory out) {
        if (rs.length == 0 || rs.length > MAX_READERS) revert BadReaders();
        bool hasOwner;
        for (uint256 i; i < rs.length; ++i) {
            if (i > 0 && uint160(rs[i]) <= uint160(rs[i - 1])) revert BadReaders();
            if (rs[i] == owner) hasOwner = true;
            out = i == 0 ? bech32(rs[i]) : abi.encodePacked(out, ", ", bech32(rs[i]));
        }
        if (!hasOwner) revert BadReaders();
    }

    // ---- opens -----------------------------------------------------------------

    /// Approve a device key (made and kept in one browser or machine) to sign open
    /// requests for `account` until `untilBlock`. Signed once by the account's own
    /// ML-DSA-87 key (one QoreX approval). An `untilBlock` in the past revokes it.
    /// @dev Access control: the account's ML-DSA-87 signature over deviceText. untilBlock is capped at
    /// block.number + 200,000 (checked arithmetic, no overflow possible).
    function setDevice(address account, bytes calldata deviceKey, uint64 untilBlock, bytes calldata pqSig) external {
        if (deviceKey.length != ML_DSA_87_PUBLIC_KEY_LENGTH) revert BadDevice();
        if (untilBlock > block.number + MAX_DEVICE_BLOCKS) revert BadDevice();
        bytes32 id = keccak256(deviceKey);
        _verify(account, deviceText(account, id, untilBlock), pqSig);
        devices[account][id] = untilBlock;
        emit DeviceSet(account, id, untilBlock);
    }

    function deviceText(address account, bytes32 id, uint64 untilBlock) public view returns (bytes memory) {
        return abi.encodePacked(
            "Coffer device v1\nAccount: ",
            bech32(account),
            "\nDevice key: ",
            _hex(abi.encodePacked(id)),
            "\nValid until block: ",
            _dec(untilBlock),
            "\nSign this only on ",
            site,
            "."
        );
    }

    /// Record an open. Refused unless the reader is on the file's current list, the
    /// request names the file's latest epoch and version, and it carries the
    /// reader's signature, or an approved device's. `deviceKey` is empty when the
    /// reader's own account key signed. `release` is that version's release piece
    /// sealed to the request's one time reply key.
    /// @dev Access control: the reader must be on the file's current list (memberAt) and sign the request
    /// with its own ML-DSA-87 key or an approved device key; each nonce works once.
    function open(OpenRequest calldata r, bytes calldata deviceKey, bytes calldata sig, bytes calldata release) external {
        Head memory h = heads[r.file];
        if (h.owner == address(0)) revert NoHead();
        if (memberAt[r.file][r.reader] != h.epoch) revert NotReader(r.reader);
        if (r.epoch != h.epoch || r.version != h.version) revert NotLatest(h.epoch, h.version);
        if (r.replyKey == bytes32(0)) revert BadReplyKey();
        if (usedNonce[r.reader][r.nonce]) revert UsedNonce();
        if (release.length == 0 || release.length > MAX_RELEASE) revert BadRelease();
        bytes32 device = _openSigner(r, deviceKey, sig);
        usedNonce[r.reader][r.nonce] = true;
        _logOpen(r, device, release);
    }

    /// Check the request's signature: the reader's own key, or a device key it approved and that has not expired.
    function _openSigner(OpenRequest calldata r, bytes calldata deviceKey, bytes calldata sig) internal view returns (bytes32 device) {
        bytes memory text = openText(r);
        if (deviceKey.length == 0) {
            _verify(r.reader, text, sig);
            return bytes32(0);
        }
        if (deviceKey.length != ML_DSA_87_PUBLIC_KEY_LENGTH) revert BadDevice();
        device = keccak256(deviceKey);
        if (devices[r.reader][device] < block.number) revert DeviceNotApproved();
        _verifyWith(deviceKey, text, sig);
    }

    function _logOpen(OpenRequest calldata r, bytes32 device, bytes calldata release) internal {
        _opens[r.file].push(OpenRecord(r.reader, r.epoch, r.version, uint64(block.number)));
        emit Opened(r.file, r.reader, r.epoch, r.version, r.nonce, device, r.replyKey, release);
    }

    /// Every open of a file, oldest first: the access log.
    function opensOf(bytes16 file) external view returns (OpenRecord[] memory) {
        return _opens[file];
    }

    function openText(OpenRequest calldata r) public view returns (bytes memory) {
        return abi.encodePacked(
            abi.encodePacked(
                "Coffer open v2\nFile: ",
                _hex(abi.encodePacked(r.file)),
                "\nEpoch: ",
                _dec(r.epoch),
                "\nVersion: ",
                _dec(r.version),
                "\nReader: ",
                bech32(r.reader)
            ),
            "\nReply key: ",
            _hex(abi.encodePacked(r.replyKey)),
            "\nNonce: ",
            _dec(r.nonce),
            "\nSign this only on ",
            site,
            "."
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
        _verifyWith(provenKey(account), text, pqSig);
    }

    function _verifyWith(bytes memory key, bytes memory text, bytes calldata pqSig) internal view {
        bytes memory signed = abi.encodePacked("qorechain-msg-v1|", chainId, "|", text);
        (bool ok, bytes memory ret) =
            VERIFY.staticcall(abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", key, pqSig, signed));
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
