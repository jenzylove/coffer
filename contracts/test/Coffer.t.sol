// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Coffer} from "../src/Coffer.sol";
import {Vectors as V} from "./Vectors.sol";

/// Stand-in for the chain's PQC key status precompile (0x0A02).
contract MockStatus {
    struct K { bool registered; uint8 alg; bytes key; bool proven; }
    mapping(address => K) internal keys;

    function set(address a, bool registered, uint8 alg, bytes calldata key, bool proven) external {
        keys[a] = K(registered, alg, key, proven);
    }

    function pqcKeyStatus(address a) external view returns (bool, uint8, bytes memory, bool) {
        K memory k = keys[a];
        return (k.registered, k.alg, k.key, k.proven);
    }
}

/// Stand-in for the ML-DSA-87 verify precompile (0x0A01): true only for triples the test allowed.
contract MockVerify {
    mapping(bytes32 => bool) internal ok;

    function allow(bytes calldata pk, bytes calldata sig, bytes calldata msg_) external {
        ok[keccak256(abi.encode(pk, sig, msg_))] = true;
    }

    function pqcVerify(bytes calldata pk, bytes calldata sig, bytes calldata msg_) external view returns (bool) {
        return ok[keccak256(abi.encode(pk, sig, msg_))];
    }
}

contract CofferTest is Test {
    address constant VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant STATUS = 0x0000000000000000000000000000000000000a02;
    Coffer c;
    bytes constant PK = hex"0102030405";
    bytes constant SIG = hex"aabbccdd";
    bytes mlkem = new bytes(1568);

    event CardSet(address indexed account, bytes32 mlkemSha3, bytes32 x25519, string issuedAt, bytes mlkemKey, bytes card);
    event HeadSet(bytes16 indexed file, address indexed owner, uint64 epoch, uint64 version, bytes32 access, bytes32 data, string name, bytes sealedFile);

    function setUp() public {
        vm.etch(STATUS, address(new MockStatus()).code);
        vm.etch(VERIFY, address(new MockVerify()).code);
        MockStatus(STATUS).set(V.ACCOUNT, true, 1, PK, true);
        c = new Coffer(V.CHAIN_ID, V.SITE);
    }

    function signed(bytes memory text) internal pure returns (bytes memory) {
        return abi.encodePacked("qorechain-msg-v1|", V.CHAIN_ID, "|", text);
    }

    function allowCard(string memory issuedAt) internal returns (bytes memory text) {
        text = c.cardText(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, issuedAt);
        MockVerify(VERIFY).allow(PK, SIG, signed(text));
    }

    // ---- texts match the TypeScript code byte for byte ----------------------

    function test_bech32_matches_qoresign() public view {
        assertEq(c.bech32(V.ACCOUNT), V.ACCOUNT_BECH32);
    }

    function test_card_text_matches_qoreseal() public view {
        assertEq(c.cardText(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, V.ISSUED_AT), V.CARD_TEXT);
    }

    // ---- cards ------------------------------------------------------------------

    function test_card_set_and_replaced_by_newer_only() public {
        allowCard(V.ISSUED_AT);
        vm.expectEmit(true, false, false, true);
        emit CardSet(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, V.ISSUED_AT, mlkem, "{}");
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, V.ISSUED_AT, SIG, mlkem, "{}");
        (bytes32 h, bytes32 x, bytes32 t, uint64 height) = c.cards(V.ACCOUNT);
        assertEq(h, V.MLKEM_SHA3);
        assertEq(x, V.X25519);
        assertEq(t, bytes32(bytes(V.ISSUED_AT)));
        assertEq(height, block.number);

        // the same card again, or an older one, is refused
        vm.expectRevert(Coffer.StaleCard.selector);
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, V.ISSUED_AT, SIG, mlkem, "{}");
        allowCard("2026-11-21T09:00:00Z");
        vm.expectRevert(Coffer.StaleCard.selector);
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, "2026-11-21T09:00:00Z", SIG, mlkem, "{}");

        // a newer one replaces it
        allowCard("2026-11-23T09:00:00Z");
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, "2026-11-23T09:00:00Z", SIG, mlkem, "{}");
        (,, t,) = c.cards(V.ACCOUNT);
        assertEq(t, bytes32(bytes("2026-11-23T09:00:00Z")));
    }

    function test_card_with_wrong_signature_refused() public {
        allowCard(V.ISSUED_AT);
        vm.expectRevert(Coffer.BadSignature.selector);
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, V.ISSUED_AT, hex"aabbccde", mlkem, "{}");
    }

    function test_card_for_other_keys_refused() public {
        allowCard(V.ISSUED_AT); // signature covers V.X25519, not this one
        vm.expectRevert(Coffer.BadSignature.selector);
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, bytes32(uint256(7)), V.ISSUED_AT, SIG, mlkem, "{}");
    }

    function test_card_for_other_account_refused() public {
        allowCard(V.ISSUED_AT);
        address other = address(0xBEEF);
        MockStatus(STATUS).set(other, true, 1, PK, true); // even with the same key, the text names another address
        vm.expectRevert(Coffer.BadSignature.selector);
        c.setCard(other, V.MLKEM_SHA3, V.X25519, V.ISSUED_AT, SIG, mlkem, "{}");
    }

    function test_unproven_key_refused() public {
        MockStatus(STATUS).set(V.ACCOUNT, true, 1, PK, false);
        allowCard(V.ISSUED_AT);
        vm.expectRevert(abi.encodeWithSelector(Coffer.NoProvenKey.selector, V.ACCOUNT));
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, V.ISSUED_AT, SIG, mlkem, "{}");
    }

    function test_unregistered_account_refused() public {
        address nobody = address(0xCAFE);
        vm.expectRevert(abi.encodeWithSelector(Coffer.NoProvenKey.selector, nobody));
        c.setCard(nobody, V.MLKEM_SHA3, V.X25519, V.ISSUED_AT, SIG, mlkem, "{}");
    }

    function test_bad_issued_at_refused() public {
        vm.expectRevert(Coffer.BadIssuedAt.selector);
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, "2026-11-22 09:00:00Z", SIG, mlkem, "{}");
        vm.expectRevert(Coffer.BadIssuedAt.selector);
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, "2026-11-22T09:00:00", SIG, mlkem, "{}");
    }

    function test_bad_key_length_refused() public {
        allowCard(V.ISSUED_AT);
        vm.expectRevert(Coffer.BadKeyLength.selector);
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, V.ISSUED_AT, SIG, new bytes(1567), "{}");
    }

    // ---- heads ------------------------------------------------------------------

    bytes constant FILE_TEXT = "# Sealed by Coffer\ncoffer: 2\n";

    function change(uint64 epoch, uint64 version) internal pure returns (Coffer.Change memory ch) {
        address[] memory rs = new address[](2);
        rs[0] = V.READER_0;
        rs[1] = V.READER_1;
        ch = Coffer.Change(V.FILE, V.ACCOUNT, epoch, version, V.ACCESS, V.DATA, V.NAME, rs);
    }

    function allowHead(Coffer.Change memory ch) internal {
        MockVerify(VERIFY).allow(PK, SIG, signed(c.changeText(ch)));
    }

    function test_change_text_matches_vault() public view {
        assertEq(c.changeText(change(3, 12)), V.CHANGE_TEXT);
    }

    function test_head_binds_owner_delivers_and_only_moves_forward() public {
        Coffer.Change memory ch = change(3, 12);
        allowHead(ch);
        vm.expectEmit(true, true, false, true);
        emit HeadSet(V.FILE, V.ACCOUNT, 3, 12, V.ACCESS, V.DATA, V.NAME, FILE_TEXT);
        c.setHead(ch, FILE_TEXT, SIG);
        (address owner, uint64 epoch, uint64 version,, bytes32 access, bytes32 data) = c.heads(V.FILE);
        assertEq(owner, V.ACCOUNT);
        assertEq(epoch, 3);
        assertEq(version, 12);
        assertEq(access, V.ACCESS);
        assertEq(data, V.DATA);
        // every reader finds the file under their own address, once
        assertEq(c.filesOf(V.OTHER).length, 1);
        assertEq(c.filesOf(V.OTHER)[0], V.FILE);
        assertEq(c.filesOf(V.ACCOUNT).length, 1);
        assertTrue(c.listed(V.OTHER, V.FILE));

        // replaying the same change, or an older one, is refused
        vm.expectRevert(abi.encodeWithSelector(Coffer.StaleEpoch.selector, uint64(3)));
        c.setHead(ch, FILE_TEXT, SIG);
        Coffer.Change memory old = change(2, 9);
        allowHead(old);
        vm.expectRevert(abi.encodeWithSelector(Coffer.StaleEpoch.selector, uint64(3)));
        c.setHead(old, FILE_TEXT, SIG);

        // a newer epoch must also carry a newer version
        Coffer.Change memory sameVersion = change(4, 12);
        allowHead(sameVersion);
        vm.expectRevert(abi.encodeWithSelector(Coffer.StaleVersion.selector, uint64(12)));
        c.setHead(sameVersion, FILE_TEXT, SIG);

        Coffer.Change memory next = change(4, 13);
        allowHead(next);
        c.setHead(next, FILE_TEXT, SIG);
        (, epoch,,,,) = c.heads(V.FILE);
        assertEq(epoch, 4);
        assertEq(c.filesOf(V.OTHER).length, 1); // not listed twice
    }

    function test_head_of_someone_elses_file_refused() public {
        Coffer.Change memory ch = change(3, 12);
        allowHead(ch);
        c.setHead(ch, FILE_TEXT, SIG);
        address mallory = address(0xBAD);
        MockStatus(STATUS).set(mallory, true, 1, hex"0909", true);
        Coffer.Change memory evil = change(9, 20);
        evil.owner = mallory;
        address[] memory rs = new address[](1);
        rs[0] = mallory;
        evil.readers = rs;
        MockVerify(VERIFY).allow(hex"0909", SIG, signed(c.changeText(evil)));
        vm.expectRevert(abi.encodeWithSelector(Coffer.NotOwner.selector, V.ACCOUNT));
        c.setHead(evil, FILE_TEXT, SIG);
    }

    function test_head_with_changed_fields_or_readers_refused() public {
        Coffer.Change memory ch = change(3, 12);
        allowHead(ch);
        Coffer.Change memory x = change(3, 12);
        x.access = bytes32(uint256(1));
        vm.expectRevert(Coffer.BadSignature.selector);
        c.setHead(x, FILE_TEXT, SIG);
        x = change(3, 12);
        x.name = ".env.prod";
        vm.expectRevert(Coffer.BadSignature.selector);
        c.setHead(x, FILE_TEXT, SIG);
        // a reader slipped in that the owner never approved
        x = change(3, 12);
        address[] memory rs = new address[](3);
        rs[0] = V.READER_0;
        rs[1] = V.READER_1;
        rs[2] = address(type(uint160).max);
        x.readers = rs;
        vm.expectRevert(Coffer.BadSignature.selector);
        c.setHead(x, FILE_TEXT, SIG);
    }

    function test_reader_list_must_be_sorted_and_hold_the_owner() public {
        Coffer.Change memory x = change(3, 12);
        address[] memory rs = new address[](2);
        rs[0] = V.READER_1;
        rs[1] = V.READER_0;
        x.readers = rs;
        vm.expectRevert(Coffer.BadReaders.selector);
        c.setHead(x, FILE_TEXT, SIG);
        x = change(3, 12);
        rs = new address[](1);
        rs[0] = V.OTHER;
        x.readers = rs;
        vm.expectRevert(Coffer.BadReaders.selector);
        c.setHead(x, FILE_TEXT, SIG);
    }

    function test_bad_name_and_file_refused() public {
        Coffer.Change memory x = change(3, 12);
        x.name = ".env\nReaders: everyone";
        vm.expectRevert(Coffer.BadName.selector);
        c.setHead(x, FILE_TEXT, SIG);
        vm.expectRevert(Coffer.BadFile.selector);
        c.setHead(change(3, 12), "", SIG);
    }

    // ---- writes -----------------------------------------------------------------

    event Written(bytes16 indexed file, address indexed writer, uint64 version);

    bytes32 constant DATA2 = bytes32(uint256(0xd2));

    function wr(uint64 epoch, uint64 version, address writer) internal pure returns (Coffer.Write memory) {
        return Coffer.Write(V.FILE, epoch, version, V.ACCESS, DATA2, V.NAME, writer);
    }

    function allowWrite(Coffer.Write memory w, bytes memory key) internal {
        MockVerify(VERIFY).allow(key, SIG, signed(c.writeText(w)));
    }

    function test_write_text_matches_vault() public view {
        Coffer.Write memory w = wr(3, 13, V.OTHER);
        w.data = V.DATA;
        assertEq(c.writeText(w), V.WRITE_TEXT);
    }

    function test_reader_writes_a_new_version_and_it_is_delivered() public {
        headAt(3); // version 3
        MockStatus(STATUS).set(V.OTHER, true, 1, hex"0707", true);
        Coffer.Write memory w = wr(3, 4, V.OTHER);
        allowWrite(w, hex"0707");
        vm.expectEmit(true, true, false, true);
        emit HeadSet(V.FILE, V.ACCOUNT, 3, 4, V.ACCESS, DATA2, V.NAME, FILE_TEXT);
        vm.expectEmit(true, true, false, true);
        emit Written(V.FILE, V.OTHER, 4);
        c.write(w, FILE_TEXT, SIG);
        (address owner, uint64 epoch, uint64 version,, bytes32 access, bytes32 data) = c.heads(V.FILE);
        assertEq(owner, V.ACCOUNT);
        assertEq(epoch, 3);
        assertEq(version, 4);
        assertEq(access, V.ACCESS);
        assertEq(data, DATA2);
        // the same write again, or an older version, is refused: no rollback
        vm.expectRevert(abi.encodeWithSelector(Coffer.StaleVersion.selector, uint64(4)));
        c.write(w, FILE_TEXT, SIG);
        // opens must now name the new version
        MockVerify(VERIFY).allow(hex"0707", SIG, signed(c.openText(req(3, 3, V.OTHER, 9))));
        vm.expectRevert(abi.encodeWithSelector(Coffer.NotLatest.selector, uint64(3), uint64(4)));
        c.open(req(3, 3, V.OTHER, 9), "", SIG, RELEASE);
    }

    function test_write_refused_unless_a_current_reader_signs_the_current_access() public {
        Coffer.Write memory w = wr(3, 4, V.OTHER);
        vm.expectRevert(Coffer.NoHead.selector);
        c.write(w, FILE_TEXT, SIG);
        headAt(3);
        MockStatus(STATUS).set(V.OTHER, true, 1, hex"0707", true);
        // not signed by the writer
        vm.expectRevert(Coffer.BadSignature.selector);
        c.write(w, FILE_TEXT, SIG);
        // another epoch, other readers, or an empty file
        Coffer.Write memory x = wr(2, 4, V.OTHER);
        vm.expectRevert(abi.encodeWithSelector(Coffer.StaleEpoch.selector, uint64(3)));
        c.write(x, FILE_TEXT, SIG);
        x = wr(3, 4, V.OTHER);
        x.access = bytes32(uint256(1));
        vm.expectRevert(Coffer.BadAccess.selector);
        c.write(x, FILE_TEXT, SIG);
        vm.expectRevert(Coffer.BadFile.selector);
        c.write(w, "", SIG);
        // someone never on the list
        x = wr(3, 4, address(0xD00D));
        vm.expectRevert(abi.encodeWithSelector(Coffer.NotReader.selector, address(0xD00D)));
        c.write(x, FILE_TEXT, SIG);
        // a removed reader, with a valid signature
        Coffer.Change memory ch = change(4, 4);
        address[] memory rs = new address[](1);
        rs[0] = V.ACCOUNT;
        ch.readers = rs;
        allowHead(ch);
        c.setHead(ch, FILE_TEXT, SIG);
        x = wr(4, 5, V.OTHER);
        allowWrite(x, hex"0707");
        vm.expectRevert(abi.encodeWithSelector(Coffer.NotReader.selector, V.OTHER));
        c.write(x, FILE_TEXT, SIG);
    }

    // ---- opens ------------------------------------------------------------------

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
    event DeviceSet(address indexed account, bytes32 indexed device, uint64 untilBlock);

    bytes constant RELEASE = hex"0badc0de";

    function req(uint64 epoch, uint64 version, address reader, uint64 nonce) internal pure returns (Coffer.OpenRequest memory) {
        return Coffer.OpenRequest(V.FILE, epoch, version, reader, V.REPLY_KEY, nonce);
    }

    /// A head at `epoch` (version = epoch) whose readers are V.READER_0 and V.READER_1 (V.ACCOUNT and V.OTHER).
    function headAt(uint64 epoch) internal {
        Coffer.Change memory ch = change(epoch, epoch);
        allowHead(ch);
        c.setHead(ch, FILE_TEXT, SIG);
    }

    function test_open_and_device_texts_match_vault() public {
        headAt(3);
        assertEq(c.openText(req(3, 3, V.OTHER, 42)), V.OPEN_TEXT);
        assertEq(c.deviceText(V.OTHER, V.DEVICE_ID, 123456), V.DEVICE_TEXT);
    }

    function test_current_reader_opens_with_own_key_and_it_is_logged() public {
        headAt(3);
        MockStatus(STATUS).set(V.OTHER, true, 1, hex"0707", true);
        MockVerify(VERIFY).allow(hex"0707", SIG, signed(c.openText(req(3, 3, V.OTHER, 42))));
        vm.expectEmit(true, true, false, true);
        emit Opened(V.FILE, V.OTHER, 3, 3, 42, bytes32(0), V.REPLY_KEY, RELEASE);
        c.open(req(3, 3, V.OTHER, 42), "", SIG, RELEASE);
        Coffer.OpenRecord[] memory log = c.opensOf(V.FILE);
        assertEq(log.length, 1);
        assertEq(log[0].reader, V.OTHER);
        assertEq(log[0].epoch, 3);
        assertEq(log[0].version, 3);
        // the same request cannot be replayed
        vm.expectRevert(Coffer.UsedNonce.selector);
        c.open(req(3, 3, V.OTHER, 42), "", SIG, RELEASE);
    }

    function test_reply_key_is_part_of_the_signed_request() public {
        headAt(3);
        MockStatus(STATUS).set(V.OTHER, true, 1, hex"0707", true);
        MockVerify(VERIFY).allow(hex"0707", SIG, signed(c.openText(req(3, 3, V.OTHER, 42))));
        // someone who saw the signed request cannot point the release at their own reply key
        Coffer.OpenRequest memory r = req(3, 3, V.OTHER, 42);
        r.replyKey = bytes32(uint256(0xbad));
        vm.expectRevert(Coffer.BadSignature.selector);
        c.open(r, "", SIG, RELEASE);
        r.replyKey = bytes32(0);
        vm.expectRevert(Coffer.BadReplyKey.selector);
        c.open(r, "", SIG, RELEASE);
    }

    function test_removed_reader_cannot_open_any_copy_old_or_new() public {
        headAt(3);
        MockStatus(STATUS).set(V.OTHER, true, 1, hex"0707", true);
        // epoch 4: the owner alone
        Coffer.Change memory ch = change(4, 4);
        address[] memory rs = new address[](1);
        rs[0] = V.ACCOUNT;
        ch.readers = rs;
        allowHead(ch);
        c.setHead(ch, FILE_TEXT, SIG);
        // the copy of epoch 3 they still hold, with a perfectly valid signature: refused
        MockVerify(VERIFY).allow(hex"0707", SIG, signed(c.openText(req(3, 3, V.OTHER, 1))));
        vm.expectRevert(abi.encodeWithSelector(Coffer.NotReader.selector, V.OTHER));
        c.open(req(3, 3, V.OTHER, 1), "", SIG, RELEASE);
        vm.expectRevert(abi.encodeWithSelector(Coffer.NotReader.selector, V.OTHER));
        c.open(req(4, 4, V.OTHER, 2), "", SIG, RELEASE);
        // someone never on the list: refused
        vm.expectRevert(abi.encodeWithSelector(Coffer.NotReader.selector, address(0xD00D)));
        c.open(req(4, 4, address(0xD00D), 3), "", SIG, RELEASE);
        // added back at epoch 5: opens again
        Coffer.Change memory back = change(5, 5);
        allowHead(back);
        c.setHead(back, FILE_TEXT, SIG);
        MockVerify(VERIFY).allow(hex"0707", SIG, signed(c.openText(req(5, 5, V.OTHER, 4))));
        c.open(req(5, 5, V.OTHER, 4), "", SIG, RELEASE);
    }

    function test_open_needs_the_readers_signature() public {
        headAt(3);
        MockStatus(STATUS).set(V.OTHER, true, 1, hex"0707", true);
        vm.expectRevert(Coffer.BadSignature.selector);
        c.open(req(3, 3, V.OTHER, 42), "", SIG, RELEASE);
    }

    function test_open_only_the_latest_version_and_bad_inputs_refused() public {
        vm.expectRevert(Coffer.NoHead.selector);
        c.open(req(3, 3, V.OTHER, 1), "", SIG, RELEASE);
        headAt(3);
        vm.expectRevert(abi.encodeWithSelector(Coffer.NotLatest.selector, uint64(3), uint64(3)));
        c.open(req(4, 4, V.OTHER, 1), "", SIG, RELEASE);
        vm.expectRevert(abi.encodeWithSelector(Coffer.NotLatest.selector, uint64(3), uint64(3)));
        c.open(req(3, 2, V.OTHER, 1), "", SIG, RELEASE);
        vm.expectRevert(abi.encodeWithSelector(Coffer.NotLatest.selector, uint64(3), uint64(3)));
        c.open(req(0, 3, V.OTHER, 1), "", SIG, RELEASE);
        vm.expectRevert(Coffer.BadRelease.selector);
        c.open(req(3, 3, V.OTHER, 1), "", SIG, "");
        vm.expectRevert(Coffer.BadDevice.selector);
        c.open(req(3, 3, V.OTHER, 1), hex"01", SIG, RELEASE);
    }

    function test_device_approved_by_the_account_opens_until_it_expires() public {
        headAt(3);
        MockStatus(STATUS).set(V.OTHER, true, 1, hex"0707", true);
        bytes memory dev = new bytes(2592);
        dev[0] = 0x42;
        bytes32 id = keccak256(dev);
        uint64 until = uint64(block.number + 100);
        // not approved yet
        MockVerify(VERIFY).allow(dev, SIG, signed(c.openText(req(3, 3, V.OTHER, 1))));
        vm.expectRevert(Coffer.DeviceNotApproved.selector);
        c.open(req(3, 3, V.OTHER, 1), dev, SIG, RELEASE);
        // the account approves it (one wallet signature)
        MockVerify(VERIFY).allow(hex"0707", SIG, signed(c.deviceText(V.OTHER, id, until)));
        vm.expectEmit(true, true, false, true);
        emit DeviceSet(V.OTHER, id, until);
        c.setDevice(V.OTHER, dev, until, SIG);
        c.open(req(3, 3, V.OTHER, 1), dev, SIG, RELEASE);
        // a different device signature over another request: refused
        vm.expectRevert(Coffer.BadSignature.selector);
        c.open(req(3, 3, V.OTHER, 2), dev, SIG, RELEASE);
        // after it expires
        vm.roll(block.number + 101);
        MockVerify(VERIFY).allow(dev, SIG, signed(c.openText(req(3, 3, V.OTHER, 3))));
        vm.expectRevert(Coffer.DeviceNotApproved.selector);
        c.open(req(3, 3, V.OTHER, 3), dev, SIG, RELEASE);
    }

    function test_device_approval_must_be_signed_by_the_account_and_short() public {
        bytes memory dev = new bytes(2592);
        uint64 until = uint64(block.number + 100);
        MockStatus(STATUS).set(V.OTHER, true, 1, hex"0707", true);
        vm.expectRevert(Coffer.BadSignature.selector);
        c.setDevice(V.OTHER, dev, until, SIG);
        vm.expectRevert(Coffer.BadDevice.selector);
        c.setDevice(V.OTHER, dev, uint64(block.number + 200_001), SIG);
        vm.expectRevert(Coffer.BadDevice.selector);
        c.setDevice(V.OTHER, hex"0102", until, SIG);
    }

    function test_epoch_zero_head_refused() public {
        Coffer.Change memory ch = change(0, 1);
        vm.expectRevert(Coffer.BadEpoch.selector);
        c.setHead(ch, FILE_TEXT, SIG);
    }

    function test_inactive_precompile_is_an_error() public {
        vm.etch(STATUS, "");
        vm.expectRevert(Coffer.PrecompileInactive.selector);
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, V.ISSUED_AT, SIG, mlkem, "{}");
    }
}
