// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Research prototype: member institutions attest to KYC, not real-world identity.
/// @dev Only keyed identity references and salted commitments belong on this ledger.
contract KYCRegistry {
    address public immutable administrator;
    mapping(address => bool) public members;
    struct Version { bytes32 digest; bytes32 previousDigest; uint64 timestamp; uint8 status; }
    struct Identity { address issuer; uint256 latest; }
    struct Grant { uint256 version; uint64 expiresAt; bool active; }
    mapping(bytes32 => Identity) public identities;
    mapping(bytes32 => mapping(uint256 => Version)) public versions;
    mapping(bytes32 => mapping(address => Grant)) public grants;
    event MemberAdded(address indexed member);
    event VersionAnchored(bytes32 indexed identity, uint256 indexed version, address indexed issuer, bytes32 digest, bytes32 previousDigest, uint8 status);
    event ConsentRecorded(bytes32 indexed identity, address indexed recipient, uint256 version, bool active, uint64 expiresAt);
    event VerificationReused(bytes32 indexed identity, uint256 indexed version, address indexed recipient);

    constructor() { administrator = msg.sender; }
    function addMember(address member) external {
        require(msg.sender == administrator, "Administrator only");
        require(member != address(0) && !members[member], "Invalid member");
        members[member] = true;
        emit MemberAdded(member);
    }
    function anchor(bytes32 identity, bytes32 digest, bytes32 previousDigest, uint256 expectedVersion, uint8 status) external {
        require(members[msg.sender], "Member only");
        require(identity != bytes32(0) && digest != bytes32(0) && status <= 2, "Invalid commitment");
        Identity storage item = identities[identity];
        require(item.latest == expectedVersion, "Stale version");
        if (item.latest == 0) {
            require(previousDigest == bytes32(0) && status == 0, "Invalid initial version");
            item.issuer = msg.sender;
        } else {
            require(item.issuer == msg.sender, "Issuer only");
            require(versions[identity][item.latest].digest == previousDigest, "Broken version link");
            require(versions[identity][item.latest].status != 2, "Identity revoked");
        }
        item.latest++;
        versions[identity][item.latest] = Version(digest, previousDigest, uint64(block.timestamp), status);
        emit VersionAnchored(identity, item.latest, msg.sender, digest, previousDigest, status);
    }
    // The issuer relays consent authenticated by the application's customer portal.
    // Direct, independently signed customer consent is outside this prototype's trust model.
    function recordConsent(bytes32 identity, address recipient, uint256 version, bool active, uint64 expiresAt) external {
        Identity memory item = identities[identity];
        require(item.issuer == msg.sender, "Issuer only");
        require(members[recipient] && recipient != msg.sender, "Invalid recipient");
        if (active) {
            require(version == item.latest && versions[identity][version].status == 1, "Verified latest version required");
            require(expiresAt > block.timestamp, "Consent expired");
        }
        grants[identity][recipient] = Grant(version, expiresAt, active);
        emit ConsentRecorded(identity, recipient, version, active, expiresAt);
    }
    function reuse(bytes32 identity, uint256 version) external {
        require(members[msg.sender], "Member only");
        Grant memory grant = grants[identity][msg.sender];
        require(grant.active && grant.version == version && grant.expiresAt > block.timestamp, "Consent required");
        require(identities[identity].latest == version && versions[identity][version].status == 1, "Verification stale or revoked");
        emit VerificationReused(identity, version, msg.sender);
    }
}
