import 'package:flutter/material.dart';
import '../api.dart';
import '../calendar.dart';
import '../models.dart';
import 'basic_forms.dart';
import 'medicine_detail.dart';
import 'prescription_form.dart';
import 'shared.dart';

class MedicinesTab extends StatefulWidget {
  const MedicinesTab(
      {super.key,
      required this.patient,
      required this.repo,
      required this.onChanged});
  final Patient patient;
  final Repository repo;
  final VoidCallback onChanged;
  @override
  State<MedicinesTab> createState() => _MedicinesTabState();
}

class _MedicinesTabState extends State<MedicinesTab> {
  late Future<List<Medicine>> future;
  @override
  void initState() {
    super.initState();
    future = widget.repo.medicines(widget.patient.id);
  }

  Future<void> refresh() async {
    setState(() {
      future = widget.repo.medicines(widget.patient.id);
    });
    try {
      await future;
    } catch (_) {}
  }

  Future<void> add() async {
    if (await recordPrescription(context,
            patient: widget.patient, repo: widget.repo) &&
        mounted) {
      widget.onChanged();
    }
  }

  @override
  Widget build(BuildContext context) =>
      ContentList(onRefresh: refresh, children: [
        SectionTitle('Current medicines',
            subtitle: 'Active courses for today in the patient’s time zone.',
            action: widget.patient.role.canManage
                ? FilledButton.icon(
                    onPressed: add,
                    icon: const Icon(Icons.add),
                    label: const Text('Add prescription'))
                : null),
        AsyncSection(
            future: future,
            retry: refresh,
            builder: (items) => items.isEmpty
                ? EmptyState(
                    title: 'No current medicines',
                    message:
                        'Record a prescription to add a course. Future and closed courses stay in Visits.',
                    icon: Icons.medication_outlined,
                    action: widget.patient.role.canManage
                        ? FilledButton(
                            onPressed: add,
                            child: const Text('Add prescription'))
                        : null)
                : Column(children: [
                    for (final item in items)
                      Padding(
                          padding: const EdgeInsets.only(bottom: 14),
                          child: InkWell(
                              borderRadius: BorderRadius.circular(20),
                              onTap: () async {
                                await Navigator.push<void>(
                                    context,
                                    MaterialPageRoute(
                                        builder: (_) => MedicineDetailPage(
                                            patient: widget.patient,
                                            medicine: item,
                                            repo: widget.repo)));
                                if (mounted) await refresh();
                              },
                              child: Panel(
                                  child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                    Text(item.name,
                                        style: Theme.of(context)
                                            .textTheme
                                            .titleMedium),
                                    const SizedBox(height: 7),
                                    Text([
                                      item.dose,
                                      if (item.frequency != null)
                                        item.frequency!
                                    ].join(' · ')),
                                    const SizedBox(height: 14),
                                    Wrap(spacing: 10, runSpacing: 8, children: [
                                      StatusBadge(
                                          item.doctor ?? 'Doctor not recorded',
                                          icon: Icons.person_outline),
                                      StatusBadge(item.endDate == null
                                          ? 'Ongoing course'
                                          : 'Through ${displayDate(item.endDate!)}')
                                    ]),
                                    const SizedBox(height: 14),
                                    const Text('View record and dose times →',
                                        style: TextStyle(
                                            color: teal,
                                            fontWeight: FontWeight.w600)),
                                  ]))))
                  ])),
      ]);
}

class VisitsTab extends StatefulWidget {
  const VisitsTab(
      {super.key,
      required this.patient,
      required this.repo,
      required this.onChanged});
  final Patient patient;
  final Repository repo;
  final VoidCallback onChanged;
  @override
  State<VisitsTab> createState() => _VisitsTabState();
}

class _VisitsTabState extends State<VisitsTab> {
  late Future<(List<Prescription>, List<Doctor>)> future;
  @override
  void initState() {
    super.initState();
    future = load();
  }

  Future<(List<Prescription>, List<Doctor>)> load() async {
    final result = await Future.wait<Object>([
      widget.repo.prescriptions(widget.patient.id),
      widget.repo.doctors(widget.patient.id)
    ]);
    return (result[0] as List<Prescription>, result[1] as List<Doctor>);
  }

  Future<void> refresh() async {
    setState(() {
      future = load();
    });
    try {
      await future;
    } catch (_) {}
  }

  Future<void> addDoctor() async {
    if (await showDialog<bool>(
                context: context,
                barrierDismissible: false,
                builder: (_) =>
                    DoctorDialog(patient: widget.patient, repo: widget.repo)) ==
            true &&
        mounted) {
      await refresh();
    }
  }

  Future<void> addVisit() async {
    if (await recordPrescription(context,
            patient: widget.patient, repo: widget.repo) &&
        mounted) {
      widget.onChanged();
    }
  }

  @override
  Widget build(BuildContext context) =>
      ContentList(onRefresh: refresh, children: [
        SectionTitle('Visits & prescriptions',
            subtitle: 'Every course keeps its source and history.',
            action: widget.patient.role.canManage
                ? FilledButton.icon(
                    onPressed: addVisit,
                    icon: const Icon(Icons.add),
                    label: const Text('Add prescription'))
                : null),
        AsyncSection(
            future: future,
            retry: refresh,
            builder: (data) => Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Panel(
                          child: ExpansionTile(
                              tilePadding: EdgeInsets.zero,
                              childrenPadding: const EdgeInsets.only(top: 14),
                              title: Text('Doctors (${data.$2.length})'),
                              subtitle: const Text(
                                  'Prescribers recorded for this patient'),
                              children: [
                            for (final doctor in data.$2)
                              ListTile(
                                  contentPadding: EdgeInsets.zero,
                                  leading: const Icon(Icons.person_outline,
                                      color: teal),
                                  title: Text(doctor.name),
                                  subtitle: Text([
                                    if (doctor.specialty != null)
                                      doctor.specialty!,
                                    if (doctor.clinic != null) doctor.clinic!,
                                    if (doctor.phone != null) doctor.phone!
                                  ].join(' · '))),
                            if (widget.patient.role.canManage)
                              Align(
                                  alignment: Alignment.centerLeft,
                                  child: OutlinedButton.icon(
                                      onPressed: addDoctor,
                                      icon: const Icon(Icons.add),
                                      label: const Text('Add doctor'))),
                          ])),
                      const SizedBox(height: 22),
                      if (data.$1.isEmpty)
                        const EmptyState(
                            title: 'No visits recorded yet',
                            message:
                                'Add a prescription with its doctor, visit date and medicines.',
                            icon: Icons.description_outlined)
                      else
                        for (final visit in data.$1)
                          Padding(
                              padding: const EdgeInsets.only(bottom: 18),
                              child: Panel(
                                  child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.stretch,
                                      children: [
                                    Text(visit.doctor ?? 'Doctor not recorded',
                                        style: Theme.of(context)
                                            .textTheme
                                            .titleLarge),
                                    const SizedBox(height: 5),
                                    Text(displayDate(visit.visitDate)),
                                    if (visit.notes != null) ...[
                                      const SizedBox(height: 12),
                                      Text(visit.notes!)
                                    ],
                                    const SizedBox(height: 12),
                                    for (final item in visit.items)
                                      Padding(
                                          padding:
                                              const EdgeInsets.only(top: 12),
                                          child: InkWell(
                                              borderRadius:
                                                  BorderRadius.circular(12),
                                              onTap: () async {
                                                await Navigator.push<void>(
                                                    context,
                                                    MaterialPageRoute(
                                                        builder: (_) =>
                                                            MedicineDetailPage(
                                                                patient: widget
                                                                    .patient,
                                                                medicine: item,
                                                                repo: widget
                                                                    .repo)));
                                                if (mounted) await refresh();
                                              },
                                              child: Container(
                                                  padding:
                                                      const EdgeInsets.all(16),
                                                  decoration: BoxDecoration(
                                                      color: canvas,
                                                      borderRadius:
                                                          BorderRadius.circular(
                                                              12)),
                                                  child: Column(
                                                      crossAxisAlignment:
                                                          CrossAxisAlignment
                                                              .start,
                                                      children: [
                                                        Text(item.name,
                                                            style: Theme.of(
                                                                    context)
                                                                .textTheme
                                                                .titleMedium),
                                                        const SizedBox(
                                                            height: 5),
                                                        Text(
                                                            '${item.dose}${item.frequency == null ? '' : ' · ${item.frequency}'}'),
                                                        const SizedBox(
                                                            height: 10),
                                                        Wrap(
                                                            spacing: 8,
                                                            runSpacing: 6,
                                                            children: [
                                                              StatusBadge(
                                                                  item.status),
                                                              StatusBadge(
                                                                  'From ${displayDate(item.startDate)}')
                                                            ]),
                                                      ])))),
                                  ]))),
                    ])),
      ]);
}
