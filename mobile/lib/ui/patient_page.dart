import 'package:flutter/material.dart';
import '../api.dart';
import '../calendar.dart';
import '../models.dart';
import 'care_tabs.dart';
import 'alerts_page.dart';
import 'records_tabs.dart';
import 'shared.dart';
import 'today_tab.dart';

class PatientPage extends StatefulWidget {
  const PatientPage({super.key, required this.patient, required this.repo});
  final Patient patient;
  final Repository repo;
  @override
  State<PatientPage> createState() => _PatientPageState();
}

class _PatientPageState extends State<PatientPage> {
  int selected = 0, revision = 0;
  void refresh() => setState(() => revision++);
  static const labels = ['Today', 'Medicines', 'Visits', 'Review', 'People'];
  static const icons = [
    Icons.today_outlined,
    Icons.medication_outlined,
    Icons.description_outlined,
    Icons.fact_check_outlined,
    Icons.people_outline
  ];
  @override
  Widget build(BuildContext context) {
    final patient = widget.patient;
    try {
      patientNow(patient.timezone);
    } catch (_) {
      return Scaffold(
          appBar: AppBar(title: Text(patient.name)),
          body: const Center(
              child: Padding(
                  padding: EdgeInsets.all(24),
                  child: Text(
                      'This patient’s time zone could not be opened. Update the app before recording doses.'))));
    }
    final helper = patient.role == PatientRole.helper;
    Widget content = switch (selected) {
      1 =>
        MedicinesTab(patient: patient, repo: widget.repo, onChanged: refresh),
      2 => VisitsTab(patient: patient, repo: widget.repo, onChanged: refresh),
      3 => ReviewTab(patient: patient, repo: widget.repo),
      4 => PeopleTab(patient: patient, repo: widget.repo),
      _ => TodayTab(patient: patient, repo: widget.repo),
    };
    final wide = MediaQuery.sizeOf(context).width >= 850;
    return Scaffold(
        appBar: AppBar(
            toolbarHeight:
                MediaQuery.textScalerOf(context).scale(56).clamp(64, 112),
            title:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(patient.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleLarge),
              Text(
                  '${patient.role.label} · ${patient.timezone.replaceAll('_', ' ')}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, color: muted)),
            ]),
            actions: [
              IconButton(
                  tooltip: 'Care alerts',
                  onPressed: () async {
                    await Navigator.push<void>(
                        context,
                        MaterialPageRoute(
                            builder: (_) => AlertsPage(repo: widget.repo)));
                    if (mounted) refresh();
                  },
                  icon: const Icon(Icons.notifications_none)),
              IconButton(
                  tooltip: 'Refresh patient view',
                  onPressed: refresh,
                  icon: const Icon(Icons.refresh)),
              const SizedBox(width: 8)
            ]),
        body: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (wide && !helper)
            NavigationRail(
                backgroundColor: canvas,
                extended: true,
                selectedIndex: selected,
                onDestinationSelected: (value) =>
                    setState(() => selected = value),
                minExtendedWidth: 180,
                destinations: [
                  for (var i = 0; i < labels.length; i++)
                    NavigationRailDestination(
                        icon: Icon(icons[i]), label: Text(labels[i]))
                ]),
          Expanded(
              child: KeyedSubtree(
                  key: ValueKey('$selected:$revision'), child: content)),
        ]),
        bottomNavigationBar: wide || helper
            ? null
            : NavigationBar(
                selectedIndex: selected,
                onDestinationSelected: (value) =>
                    setState(() => selected = value),
                destinations: [
                    for (var i = 0; i < labels.length; i++)
                      NavigationDestination(
                          icon: Icon(icons[i]), label: labels[i])
                  ]));
  }
}
