import 'package:flutter/material.dart';
import '../api.dart';
import '../calendar.dart';
import '../models.dart';
import 'prescription_form.dart';
import 'schedule_form.dart';
import 'shared.dart';

class MedicineDetailPage extends StatefulWidget {
  const MedicineDetailPage(
      {super.key,
      required this.patient,
      required this.medicine,
      required this.repo});
  final Patient patient;
  final Medicine medicine;
  final Repository repo;
  @override
  State<MedicineDetailPage> createState() => _MedicineDetailPageState();
}

class _MedicineDetailPageState extends State<MedicineDetailPage> {
  late Future<List<Schedule>> future;
  bool busy = false;
  bool get canManage =>
      widget.patient.role.canManage && widget.medicine.status == 'active';
  @override
  void initState() {
    super.initState();
    future = load();
  }

  Future<List<Schedule>> load() async =>
      (await widget.repo.schedules(widget.patient.id))
          .where((s) => s.itemId == widget.medicine.id)
          .toList();
  Future<void> refresh() async {
    setState(() {
      future = load();
    });
    try {
      await future;
    } catch (_) {}
  }

  Future<void> close(String status) async {
    if (!await confirmAction(context,
        title: 'Record as $status?',
        message:
            'This changes the shared medicine record and deactivates its dose times. Previous confirmations will be kept.',
        confirm: 'Record $status')) {
      return;
    }
    if (!mounted) return;
    setState(() => busy = true);
    try {
      await widget.repo
          .closeMedicine(widget.patient.id, widget.medicine.id, status);
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) notice(context, friendlyError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> addTime() async {
    final result = await showDialog<String>(
        context: context,
        barrierDismissible: false,
        builder: (_) => ScheduleDialog(
            patient: widget.patient,
            medicine: widget.medicine,
            repo: widget.repo));
    if (result != null && mounted) {
      notice(context, result);
      await refresh();
    }
  }

  @override
  Widget build(BuildContext context) {
    final medicine = widget.medicine;
    final expired = medicine.endDate != null &&
        medicine.endDate!
                .compareTo(dateKey(patientNow(widget.patient.timezone))) <
            0;
    return Scaffold(
        appBar: AppBar(title: const Text('Medicine record')),
        body: ContentList(onRefresh: refresh, children: [
          Text(medicine.name,
              style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 12),
          Wrap(spacing: 10, runSpacing: 8, children: [
            StatusBadge(medicine.status == 'active' && expired
                ? 'Past recorded end date'
                : medicine.status),
            if (medicine.doctor != null)
              StatusBadge(medicine.doctor!, icon: Icons.person_outline)
          ]),
          const SizedBox(height: 24),
          Panel(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                detail('Dose as recorded', medicine.dose),
                if (medicine.frequency != null)
                  detail('Frequency', medicine.frequency!),
                detail('Course starts', displayDate(medicine.startDate)),
                detail(
                    'Course ends',
                    medicine.endDate == null
                        ? 'Ongoing / not recorded'
                        : displayDate(medicine.endDate!)),
                if (medicine.brand != null) detail('Brand', medicine.brand!),
                if (medicine.ingredient != null)
                  detail('Recorded ingredient', medicine.ingredient!),
                if (medicine.strength != null)
                  detail('Strength', medicine.strength!),
              ])),
          const SizedBox(height: 28),
          SectionTitle('Dose times',
              action: canManage && !expired
                  ? FilledButton.icon(
                      onPressed: busy ? null : addTime,
                      icon: const Icon(Icons.add),
                      label: const Text('Add dose time'))
                  : null),
          AsyncSection(
              future: future,
              retry: refresh,
              builder: (schedules) => schedules.isEmpty
                  ? const EmptyState(
                      title: 'No active dose times',
                      message:
                          'An owner or family admin can add times from the prescription.',
                      icon: Icons.schedule)
                  : Column(children: [
                      for (final schedule in schedules)
                        Padding(
                            padding: const EdgeInsets.only(bottom: 12),
                            child: Panel(
                                child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                  Text(prettyTime(schedule.time),
                                      style: Theme.of(context)
                                          .textTheme
                                          .titleLarge),
                                  const SizedBox(height: 6),
                                  Text(scheduleDays(schedule.days)),
                                  Text(
                                      'From ${displayDate(schedule.startDate)}${schedule.endDate == null ? '' : ' through ${displayDate(schedule.endDate!)}'}'),
                                  if (canManage) ...[
                                    const SizedBox(height: 12),
                                    RunButton(
                                        label: 'Deactivate time',
                                        icon: Icons.event_busy_outlined,
                                        outlined: true,
                                        run: () async {
                                          if (!await confirmAction(context,
                                              title:
                                                  'Deactivate this dose time?',
                                              message:
                                                  'Future unconfirmed entries for this time will be removed. Confirmed doses will be kept.',
                                              confirm: 'Deactivate')) {
                                            return;
                                          }
                                          await widget.repo.deactivateSchedule(
                                              widget.patient.id, schedule.id);
                                          if (mounted) await refresh();
                                        })
                                  ],
                                ])))
                    ])),
          if (canManage) ...[
            const SizedBox(height: 28),
            const SectionTitle('Record a change',
                subtitle: 'Use the instructions provided by the prescriber.'),
            Panel(
                child: Wrap(spacing: 12, runSpacing: 12, children: [
              OutlinedButton.icon(
                  onPressed: busy
                      ? null
                      : () async {
                          if (await recordPrescription(context,
                                  patient: widget.patient,
                                  repo: widget.repo,
                                  replacement: medicine) &&
                              context.mounted) {
                            Navigator.pop(context);
                          }
                        },
                  icon: const Icon(Icons.swap_horiz),
                  label: const Text('Record replacement')),
              OutlinedButton(
                  onPressed: busy ? null : () => close('stopped'),
                  child: const Text('Mark stopped')),
              OutlinedButton(
                  onPressed: busy ? null : () => close('completed'),
                  child: const Text('Mark completed')),
            ])),
          ],
          const SizedBox(height: 20),
        ]));
  }

  Widget detail(String label, String value) => Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: const TextStyle(fontSize: 12, color: muted)),
        const SizedBox(height: 3),
        SelectableText(value, style: const TextStyle(fontSize: 16, color: ink))
      ]));
}
