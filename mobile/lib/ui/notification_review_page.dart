import 'package:flutter/material.dart';
import '../api.dart';
import '../models.dart';
import '../notification_contract.dart';
import 'shared.dart';
import 'today_tab.dart';

class NotificationReviewPage extends StatefulWidget {
  const NotificationReviewPage(
      {super.key, required this.repo, required this.intent});
  final Repository repo;
  final NotificationIntent intent;
  @override
  State<NotificationReviewPage> createState() => _NotificationReviewPageState();
}

class _NotificationReviewPageState extends State<NotificationReviewPage> {
  late Future<CareAlert> future;
  @override
  void initState() {
    super.initState();
    future = widget.repo.alert(widget.intent.notificationId);
  }

  Future<void> refresh() async {
    setState(() {
      future = widget.repo.alert(widget.intent.notificationId);
    });
    try {
      await future;
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) => Scaffold(
      appBar: AppBar(title: const Text('Review dose')),
      body: ContentList(onRefresh: refresh, children: [
        AsyncSection(
            future: future,
            retry: refresh,
            builder: (alert) => Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SectionTitle(alert.patient.name,
                          subtitle:
                              'Check the medicine and current shared record before recording an outcome.'),
                      if (widget.intent.action.isNotEmpty)
                        Padding(
                            padding: const EdgeInsets.only(bottom: 16),
                            child: Text(
                                'Selected action: ${switch (widget.intent.action) {
                              'taken' => 'Taken',
                              'snooze' => 'Snooze',
                              _ => 'Skip'
                            }}. Use the dose controls below to continue.')),
                      DoseCard(
                          dose: alert.dose,
                          patient: alert.patient,
                          repo: widget.repo,
                          allowConfirm: true,
                          onChanged: () async {
                            await refresh();
                            try {
                              await widget.repo.readAlert(alert.id);
                            } catch (_) {}
                          }),
                    ])),
      ]));
}
