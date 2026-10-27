import 'dart:async';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../api.dart';
import '../calendar.dart';
import '../models.dart';
import 'shared.dart';
import 'today_tab.dart';

class AlertsPage extends StatefulWidget {
  const AlertsPage({super.key, required this.repo});
  final Repository repo;
  @override
  State<AlertsPage> createState() => _AlertsPageState();
}

class _AlertsPageState extends State<AlertsPage> with WidgetsBindingObserver {
  AlertPage? page;
  final alerts = <CareAlert>[];
  Object? error;
  bool loading = false, resumed = true;
  int activeActions = 0;
  Timer? timer;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    refresh();
    timer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (resumed &&
          activeActions == 0 &&
          ModalRoute.of(context)?.isCurrent == true) {
        refresh();
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    resumed = state == AppLifecycleState.resumed;
    if (resumed && activeActions == 0) refresh();
  }

  @override
  void dispose() {
    timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> refresh({bool more = false}) async {
    if (loading || (more && page?.nextBefore == null)) return;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final result =
          await widget.repo.alerts(before: more ? page?.nextBefore : null);
      if (!mounted) return;
      setState(() {
        if (!more) alerts.clear();
        final existing = alerts.map((a) => a.id).toSet();
        alerts.addAll(result.alerts.where((a) => !existing.contains(a.id)));
        page = result;
      });
    } catch (e) {
      if (mounted) setState(() => error = e);
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
      appBar: AppBar(title: const Text('Care alerts'), actions: [
        IconButton(
            tooltip: 'Refresh alerts',
            onPressed: loading ? null : refresh,
            icon: const Icon(Icons.refresh)),
      ]),
      body: ContentList(onRefresh: refresh, children: [
        const SectionTitle('Your care inbox',
            subtitle:
                'Reminders and family alerts, with the latest saved dose status.'),
        if (loading) const LinearProgressIndicator(),
        if (error != null) ...[
          ErrorPanel(error!, retry: refresh),
          if (alerts.isNotEmpty)
            const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text(
                    'These alerts may be out of date. Refresh before recording a dose.')),
        ],
        if (page != null && !page!.workerRecent) ...[
          const Panel(
              color: Color(0xFFFFF0DB),
              child: Text(
                  'The reminder service has not checked in recently. New reminders and family alerts may be delayed.')),
          const SizedBox(height: 18),
        ],
        if (!loading && error == null && alerts.isEmpty)
          const EmptyState(
              title: 'No care alerts',
              message:
                  'Dose reminders and missed-dose family alerts will appear here.',
              icon: Icons.notifications_none),
        for (final alert in alerts) ...[
          Panel(
              key: ValueKey(alert.id),
              padding: const EdgeInsets.all(16),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Wrap(
                        alignment: WrapAlignment.spaceBetween,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        spacing: 12,
                        runSpacing: 8,
                        children: [
                          Text(
                              alert.kind == 'missed'
                                  ? 'Missed-dose family alert'
                                  : 'Dose reminder',
                              style: Theme.of(context).textTheme.titleMedium),
                          if (!alert.isRead)
                            RunButton(
                                label: 'Mark read',
                                run: () async {
                                  await widget.repo.readAlert(alert.id);
                                  if (mounted) await refresh();
                                }),
                        ]),
                    const SizedBox(height: 8),
                    Text(alert.patient.name,
                        style: Theme.of(context).textTheme.titleLarge),
                    Text(
                        '${DateFormat.yMMMd().add_jm().format(patientNow(alert.patient.timezone, instant: alert.createdAt))} · ${alert.patient.timezone}'),
                    const SizedBox(height: 14),
                    DoseCard(
                        dose: alert.dose,
                        patient: alert.patient,
                        repo: widget.repo,
                        allowConfirm: error == null,
                        onBusyChanged: (busy) => activeActions += busy ? 1 : -1,
                        onChanged: () => refresh()),
                  ])),
          const SizedBox(height: 16),
        ],
        if (page?.nextBefore != null)
          OutlinedButton(
              onPressed: loading ? null : () => refresh(more: true),
              child: const Text('Load older alerts')),
      ]));
}
