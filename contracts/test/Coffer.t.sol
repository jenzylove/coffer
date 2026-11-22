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

    function test_inactive_precompile_is_an_error() public {
        vm.etch(STATUS, "");
        vm.expectRevert(Coffer.PrecompileInactive.selector);
        c.setCard(V.ACCOUNT, V.MLKEM_SHA3, V.X25519, V.ISSUED_AT, SIG, mlkem, "{}");
    }
}
