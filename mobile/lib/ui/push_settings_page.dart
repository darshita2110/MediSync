import 'package:flutter/material.dart';
import '../push.dart';
import 'shared.dart';

class PushSettingsPage extends StatelessWidget {
  const PushSettingsPage({super.key, required this.push});
  final PushController push;
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
      animation: push,
      builder: (context, _) => Scaffold(
            appBar: AppBar(title: const Text('Phone notifications')),
            body: ContentList(children: [
              const SectionTitle('Care reminders on this phone',
                  subtitle:
                      'Enable reminders for this signed-in account. Names and medicine details stay inside the app.'),
              Panel(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    StatusBadge(
                        push.enabled ? 'Enabled on this phone' : 'Not enabled'),
                    const SizedBox(height: 16),
                    Text(push.status),
                    const SizedBox(height: 20),
                    if (push.available)
                      Wrap(spacing: 12, runSpacing: 12, children: [
                        RunButton(
                            label: push.enabled
                                ? 'Reconnect notifications'
                                : 'Enable notifications',
                            run: push.enable),
                        RunButton(
                            label: 'Turn off on this phone',
                            run: push.disable,
                            outlined: true),
                      ]),
                  ])),
              const SizedBox(height: 20),
              const Text(
                  'Taken, Snooze and Skip open the relevant dose for review before you record an outcome. Signing out turns off reminders for this account on this phone.'),
              const SizedBox(height: 12),
              const Text(
                  'Keep the care inbox available as well. Notifications can be delayed by connectivity, Android battery settings, denied permission or force-stopping the app.'),
            ]),
          ));
}
