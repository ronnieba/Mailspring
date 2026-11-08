import Foundation
import Security

/// Dedicated DEMO Gemini Keychain item. Not Electron safeStorage.
/// Password blob: `paid=0|1` newline key. Secret is read from stdin on save
/// and written to stdout on load. Never accepted from argv (do not pass the
/// password as a process argument to any Keychain CLI).
///
/// This helper calls SecItemAdd / SecItemCopyMatching / SecItemDelete.
/// Default item ACL (creating binary). No trusted-app ACL bypass.
/// Accessible when unlocked, this device only, not iCloud-syncable.
///
/// Exit: 0 ok, 1 usage/format, 2 denied/locked/cancelled, 3 not found.

let serviceName = "Mailspring-demo Gemini Developer API"
let accountName = "gemini-demo-api-key"
let itemLabel = "Mailspring-demo Gemini Developer API (DEMO)"

enum HelperExit: Int32 {
  case ok = 0
  case usage = 1
  case denied = 2
  case notFound = 3
}

func die(_ code: HelperExit, _ message: String) -> Never {
  FileHandle.standardError.write(Data("gemini-demo-keychain: \(message)\n".utf8))
  exit(code.rawValue)
}

func failClosed(_ status: OSStatus) -> Never {
  switch status {
  case errSecUserCanceled:
    die(.denied, "Keychain access cancelled")
  case errSecAuthFailed, errSecInteractionNotAllowed:
    die(.denied, "Keychain access denied or locked")
  case errSecItemNotFound:
    die(.notFound, "item not found")
  default:
    die(.denied, "Keychain error \(status)")
  }
}

func baseQuery() -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: serviceName,
    kSecAttrAccount as String: accountName,
  ]
}

func readStdinBlob() -> String {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard data.count > 0, data.count <= 8192 else {
    die(.usage, "stdin must be paid=0|1 then key (max 8192 bytes)")
  }
  guard let text = String(data: data, encoding: .utf8) else {
    die(.usage, "stdin must be UTF-8")
  }
  return text
}

func parseBlob(_ text: String) {
  let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
  let parts = normalized.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
  guard let first = parts.first, first == "paid=0" || first == "paid=1" else {
    die(.usage, "expected first line paid=0 or paid=1")
  }
  let key = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
  if key.isEmpty {
    die(.usage, "key is empty")
  }
}

func save() {
  let blob = readStdinBlob()
  parseBlob(blob)
  let payload = Data(blob.utf8)
  let deleted = SecItemDelete(baseQuery() as CFDictionary)
  if deleted != errSecSuccess && deleted != errSecItemNotFound {
    failClosed(deleted)
  }
  var add = baseQuery()
  add[kSecAttrLabel as String] = itemLabel
  add[kSecValueData as String] = payload
  add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
  add[kSecAttrSynchronizable as String] = kCFBooleanFalse as Any
  let status = SecItemAdd(add as CFDictionary, nil)
  if status == errSecSuccess {
    FileHandle.standardError.write(Data("gemini-demo-keychain: saved (value not printed)\n".utf8))
    exit(HelperExit.ok.rawValue)
  }
  failClosed(status)
}

func load() {
  var query = baseQuery()
  query[kSecReturnData as String] = kCFBooleanTrue as Any
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: AnyObject?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound {
    die(.notFound, "item not found")
  }
  if status != errSecSuccess {
    failClosed(status)
  }
  guard let data = result as? Data, let text = String(data: data, encoding: .utf8) else {
    die(.usage, "stored blob was not UTF-8")
  }
  parseBlob(text)
  FileHandle.standardOutput.write(Data(text.utf8))
  if !text.hasSuffix("\n") {
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
  exit(HelperExit.ok.rawValue)
}

func status() {
  var query = baseQuery()
  query[kSecReturnData as String] = kCFBooleanFalse as Any
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  let secStatus = SecItemCopyMatching(query as CFDictionary, nil)
  if secStatus == errSecSuccess {
    FileHandle.standardOutput.write(Data("present=true\n".utf8))
    exit(HelperExit.ok.rawValue)
  }
  if secStatus == errSecItemNotFound {
    FileHandle.standardOutput.write(Data("present=false\n".utf8))
    exit(HelperExit.ok.rawValue)
  }
  failClosed(secStatus)
}

func remove() {
  let secStatus = SecItemDelete(baseQuery() as CFDictionary)
  if secStatus == errSecSuccess || secStatus == errSecItemNotFound {
    FileHandle.standardError.write(Data("gemini-demo-keychain: removed\n".utf8))
    exit(HelperExit.ok.rawValue)
  }
  failClosed(secStatus)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first, args.count == 1 else {
  die(.usage, "usage: gemini-demo-keychain save|load|status|remove")
}

switch command {
case "save":
  save()
case "load":
  load()
case "status":
  status()
case "remove":
  remove()
default:
  die(.usage, "usage: gemini-demo-keychain save|load|status|remove")
}
