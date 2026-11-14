import Foundation
import Security

/// Dedicated DEMO Gemini Keychain helper. Not Electron safeStorage.
/// Password blob: `paid=0|1` newline key. Secret is read from stdin on
/// save/replace only — never from argv.
///
/// Two isolated items:
///   real  — service "Mailspring-demo Gemini Developer API"
///   dummy — service "Mailspring-demo Gemini Developer API (dummy)"
/// Dummy commands never query the real item. save is SecItemAdd only
/// (existing item → conflict, no delete). replace uses SecItemUpdate
/// (failure leaves the old item). dummy-remove deletes only if stored
/// bytes match the public marker (value-constrained delete).
///
/// Exit: 0 ok, 1 usage/format, 2 denied/locked/cancelled, 3 not found, 4 conflict.

let realService = "Mailspring-demo Gemini Developer API"
let realAccount = "gemini-demo-api-key"
let realLabel = "Mailspring-demo Gemini Developer API (DEMO)"
let dummyService = "Mailspring-demo Gemini Developer API (dummy)"
let dummyAccount = "gemini-demo-api-key-dummy"
let dummyLabel = "Mailspring-demo Gemini Developer API (dummy)"
let dummyMarker = "MAILSPRING_DEMO_GEMINI_NONSECRET_MARKER"
let dummyBlob = "paid=0\n\(dummyMarker)\n"

enum HelperExit: Int32 {
  case ok = 0
  case usage = 1
  case denied = 2
  case notFound = 3
  case conflict = 4
}

struct Slot {
  let service: String
  let account: String
  let label: String
}

let realSlot = Slot(service: realService, account: realAccount, label: realLabel)
let dummySlot = Slot(service: dummyService, account: dummyAccount, label: dummyLabel)

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
  case errSecDuplicateItem:
    die(.conflict, "item exists")
  default:
    die(.denied, "Keychain error \(status)")
  }
}

func baseQuery(_ slot: Slot) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: slot.service,
    kSecAttrAccount as String: slot.account,
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

func parsedKey(_ text: String) -> (paid: String, key: String)? {
  let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
  let parts = normalized.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
  guard let first = parts.first, first == "paid=0" || first == "paid=1" else {
    return nil
  }
  let key = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
  if key.isEmpty {
    return nil
  }
  return (paid: String(first.dropFirst(5)), key: key)
}

func requireBlob(_ text: String) -> String {
  guard parsedKey(text) != nil else {
    die(.usage, "expected first line paid=0 or paid=1 then a key")
  }
  return text
}

func isPublicDummyBlob(_ text: String) -> Bool {
  guard let parsed = parsedKey(text) else {
    return false
  }
  return parsed.paid == "0" && parsed.key == dummyMarker
}

func copyItemData(_ slot: Slot) -> (OSStatus, Data?) {
  var query = baseQuery(slot)
  query[kSecReturnData as String] = kCFBooleanTrue as Any
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: AnyObject?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  return (status, result as? Data)
}

func addItem(_ slot: Slot, payload: Data) -> OSStatus {
  var add = baseQuery(slot)
  add[kSecAttrLabel as String] = slot.label
  add[kSecValueData as String] = payload
  add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
  add[kSecAttrSynchronizable as String] = kCFBooleanFalse as Any
  return SecItemAdd(add as CFDictionary, nil)
}

func updateItem(_ slot: Slot, payload: Data) -> OSStatus {
  let attrs: [String: Any] = [kSecValueData as String: payload]
  return SecItemUpdate(baseQuery(slot) as CFDictionary, attrs as CFDictionary)
}

func save() {
  let blob = requireBlob(readStdinBlob())
  let status = addItem(realSlot, payload: Data(blob.utf8))
  if status == errSecSuccess {
    FileHandle.standardError.write(Data("gemini-demo-keychain: saved (value not printed)\n".utf8))
    exit(HelperExit.ok.rawValue)
  }
  if status == errSecDuplicateItem {
    die(.conflict, "item exists; use replace")
  }
  failClosed(status)
}

func replace() {
  let blob = requireBlob(readStdinBlob())
  let payload = Data(blob.utf8)
  let updated = updateItem(realSlot, payload: payload)
  if updated == errSecSuccess {
    FileHandle.standardError.write(Data("gemini-demo-keychain: replaced (value not printed)\n".utf8))
    exit(HelperExit.ok.rawValue)
  }
  if updated == errSecItemNotFound {
    let added = addItem(realSlot, payload: payload)
    if added == errSecSuccess {
      FileHandle.standardError.write(Data("gemini-demo-keychain: saved (value not printed)\n".utf8))
      exit(HelperExit.ok.rawValue)
    }
    if added == errSecDuplicateItem {
      die(.conflict, "item exists; replace lost the race (existing item not deleted)")
    }
    failClosed(added)
  }
  failClosed(updated)
}

func load(_ slot: Slot) {
  let (status, data) = copyItemData(slot)
  if status == errSecItemNotFound {
    die(.notFound, "item not found")
  }
  if status != errSecSuccess {
    failClosed(status)
  }
  guard let data, let text = String(data: data, encoding: .utf8), parsedKey(text) != nil else {
    die(.usage, "stored blob was not UTF-8 paid=0|1 then a key")
  }
  FileHandle.standardOutput.write(Data(text.utf8))
  if !text.hasSuffix("\n") {
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
  exit(HelperExit.ok.rawValue)
}

func status(_ slot: Slot) {
  var query = baseQuery(slot)
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

func removeReal() {
  let secStatus = SecItemDelete(baseQuery(realSlot) as CFDictionary)
  if secStatus == errSecSuccess || secStatus == errSecItemNotFound {
    FileHandle.standardError.write(Data("gemini-demo-keychain: removed\n".utf8))
    exit(HelperExit.ok.rawValue)
  }
  failClosed(secStatus)
}

func dummySave() {
  let payload = Data(dummyBlob.utf8)
  let (status, data) = copyItemData(dummySlot)
  if status == errSecItemNotFound {
    let added = addItem(dummySlot, payload: payload)
    if added == errSecSuccess {
      FileHandle.standardError.write(Data("gemini-demo-keychain: dummy saved (marker not printed)\n".utf8))
      exit(HelperExit.ok.rawValue)
    }
    if added == errSecDuplicateItem {
      let (again, data2) = copyItemData(dummySlot)
      if again == errSecSuccess, let data2, let text = String(data: data2, encoding: .utf8), isPublicDummyBlob(text) {
        FileHandle.standardError.write(Data("gemini-demo-keychain: dummy saved (marker not printed)\n".utf8))
        exit(HelperExit.ok.rawValue)
      }
      die(.conflict, "dummy-save refused: dummy-namespace item is not the public marker")
    }
    failClosed(added)
  }
  if status != errSecSuccess {
    failClosed(status)
  }
  guard let data, let text = String(data: data, encoding: .utf8), isPublicDummyBlob(text) else {
    die(.conflict, "dummy-save refused: dummy-namespace item is not the public marker")
  }
  FileHandle.standardError.write(Data("gemini-demo-keychain: dummy already present (marker not printed)\n".utf8))
  exit(HelperExit.ok.rawValue)
}

func dummyRemove() {
  let (status, data) = copyItemData(dummySlot)
  if status == errSecItemNotFound {
    FileHandle.standardError.write(Data("gemini-demo-keychain: dummy absent\n".utf8))
    exit(HelperExit.ok.rawValue)
  }
  if status != errSecSuccess {
    failClosed(status)
  }
  guard let data, let text = String(data: data, encoding: .utf8), isPublicDummyBlob(text) else {
    die(.conflict, "dummy-remove refused: dummy-namespace item is not the public marker")
  }
  var owned = baseQuery(dummySlot)
  owned[kSecValueData as String] = data
  let deleted = SecItemDelete(owned as CFDictionary)
  if deleted == errSecSuccess {
    FileHandle.standardError.write(Data("gemini-demo-keychain: dummy removed\n".utf8))
    exit(HelperExit.ok.rawValue)
  }
  if deleted == errSecItemNotFound {
    let (again, data2) = copyItemData(dummySlot)
    if again == errSecItemNotFound {
      FileHandle.standardError.write(Data("gemini-demo-keychain: dummy absent\n".utf8))
      exit(HelperExit.ok.rawValue)
    }
    if again == errSecSuccess, let data2, let text2 = String(data: data2, encoding: .utf8), isPublicDummyBlob(text2) {
      die(.conflict, "dummy-remove lost the race (existing non-matching item not deleted)")
    }
    if again == errSecSuccess {
      die(.conflict, "dummy-remove refused: dummy-namespace item is not the public marker")
    }
    failClosed(again)
  }
  failClosed(deleted)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first, args.count == 1 else {
  die(.usage, "usage: gemini-demo-keychain save|replace|load|status|remove|dummy-save|dummy-load|dummy-status|dummy-remove")
}

switch command {
case "save":
  save()
case "replace":
  replace()
case "load":
  load(realSlot)
case "status":
  status(realSlot)
case "remove":
  removeReal()
case "dummy-save":
  dummySave()
case "dummy-load":
  load(dummySlot)
case "dummy-status":
  status(dummySlot)
case "dummy-remove":
  dummyRemove()
default:
  die(.usage, "usage: gemini-demo-keychain save|replace|load|status|remove|dummy-save|dummy-load|dummy-status|dummy-remove")
}
