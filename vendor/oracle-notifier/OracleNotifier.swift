import Foundation
import UserNotifications

let args = CommandLine.arguments
// Usage: OracleNotifier <title> <message> [soundName]
if args.count < 3 {
  fputs("usage: OracleNotifier <title> <message> [soundName]\n", stderr)
  exit(1)
}
let title = args[1]
let message = args[2]
let soundName = args.count >= 4 ? args[3] : "Glass"

let center = UNUserNotificationCenter.current()
let group = DispatchGroup()
group.enter()
center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
  if let error = error {
    fputs("auth error: \(error)\n", stderr)
    group.leave()
    return
  }
  if !granted {
    fputs("authorization not granted\n", stderr)
    group.leave()
    return
  }
  let content = UNMutableNotificationContent()
  content.title = title
  content.body = message
  if !soundName.isEmpty {
    content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: soundName))
  } else {
    content.sound = UNNotificationSound.default
  }
  let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
  center.add(request) { addError in
    if let addError = addError {
      fputs("add error: \(addError)\n", stderr)
    }
    group.leave()
  }
}
_ = group.wait(timeout: .now() + 2)
RunLoop.current.run(until: Date().addingTimeInterval(1))
