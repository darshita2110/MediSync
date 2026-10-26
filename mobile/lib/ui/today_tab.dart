import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../api.dart';
import '../calendar.dart';
import '../models.dart';
import 'shared.dart';

class TodayTab extends StatefulWidget {
  const TodayTab({super.key, required this.patient, required this.repo});
  final Patient patient;
  final Repository repo;
  @override
  State<TodayTab> createState() => _TodayTabState();
}

class _TodayTabState extends State<TodayTab> {
  late DateTime day;
  late Future<List<Dose>> future;
  DateTime get today {
    final date = patientNow(widget.patient.timezone);
    return DateTime.utc(date.year, date.month, date.day);
  }

  @override
  void initState() {
    super.initState();
    day = today;
    future = load();
  }

  Future<List<Dose>> load() async {
    final selected = dateKey(day);
    if (widget.patient.role.canManage) {
      await widget.repo.generateDoses(widget.patient.id);
    }
    return widget.repo.doses(widget.patient.id, selected);
  }

  Future<void> refresh() async {
    setState(() {
      future = load();
    });
    try {
      await future;
    } catch (_) {}
  }

  void choose(DateTime value) {
    setState(() {
      day = DateTime.utc(value.year, value.month, value.day);
      future = load();
    });
  }

  Future<void> pickDate() async {
    final result = await showDatePicker(
        context: context,
        initialDate: day,
        firstDate: today.subtract(const Duration(days: 90)),
        lastDate: today.add(const Duration(days: 30)));
    if (result != null && mounted) choose(result);
  }

  @override
  Widget build(BuildContext context) =>
      ContentList(onRefresh: refresh, children: [
        SectionTitle(
            dateKey(day) == dateKey(today) ? 'Today’s doses' : 'Dose timeline',
            subtitle: DateFormat('EEEE, d MMMM').format(day),
            action: widget.patient.role == PatientRole.helper
                ? const StatusBadge('Today only', icon: Icons.today)
                : Wrap(
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                        IconButton(
                            tooltip: 'Previous day',
                            onPressed: day.isAfter(
                                    today.subtract(const Duration(days: 90)))
                                ? () => choose(
                                    day.subtract(const Duration(days: 1)))
                                : null,
                            icon: const Icon(Icons.chevron_left)),
                        OutlinedButton.icon(
                            onPressed: pickDate,
                            icon: const Icon(Icons.calendar_month_outlined,
                                size: 18),
                            label: const Text('Choose date')),
                        IconButton(
                            tooltip: 'Next day',
                            onPressed: day.isBefore(
                                    today.add(const Duration(days: 30)))
                                ? () => choose(day.add(const Duration(days: 1)))
                                : null,
                            icon: const Icon(Icons.chevron_right)),
                      ])),
        AsyncSection(
            future: future,
            retry: refresh,
            builder: (doses) {
              if (doses.isEmpty) {
                return EmptyState(
                    title: 'No doses scheduled',
                    icon: Icons.wb_sunny_outlined,
                    message: widget.patient.role.canManage
                        ? 'Add a prescription and its dose times to build this timeline. Upcoming doses are prepared for the next seven days.'
                        : 'There are no dose events for this date. A patient owner or family admin can add prescriptions and dose times.');
              }
              final relevant = doses
                  .where((d) => d.actionable || d.status != 'pending')
                  .length;
              final recorded = doses
                  .where((d) => d.status == 'taken' || d.status == 'skipped')
                  .length;
              return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Panel(
                        color: const Color(0xFFE7EFE4),
                        child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Wrap(spacing: 16, runSpacing: 8, children: [
                                Text('$recorded of $relevant recorded',
                                    style:
                                        Theme.of(context).textTheme.titleLarge),
                                const StatusBadge(
                                    'Shared with your care circle',
                                    icon: Icons.people_outline)
                              ]),
                              const SizedBox(height: 18),
                              ClipRRect(
                                  borderRadius: BorderRadius.circular(5),
                                  child: LinearProgressIndicator(
                                      value: relevant == 0
                                          ? 0
                                          : recorded / relevant,
                                      minHeight: 7,
                                      backgroundColor: Colors.white,
                                      color: teal)),
                              const SizedBox(height: 12),
                              Text(widget.patient.role.canConfirm
                                  ? 'Tap Taken only after the dose has been given.'
                                  : 'Read-only view. Confirmations show who recorded each dose.'),
                            ])),
                    const SizedBox(height: 22),
                    for (final dose in doses)
                      Padding(
                          padding: const EdgeInsets.only(bottom: 14),
                          child: DoseCard(
                              key: ValueKey(dose.id),
                              dose: dose,
                              patient: widget.patient,
                              repo: widget.repo,
                              allowConfirm: !day.isAfter(today),
                              onChanged: refresh)),
                  ]);
            }),
      ]);
}

class DoseCard extends StatefulWidget {
  const DoseCard(
      {super.key,
      required this.dose,
      required this.patient,
      required this.repo,
      this.onBusyChanged,
      required this.onChanged,
      required this.allowConfirm});
  final Dose dose;
  final Patient patient;
  final Repository repo;
  final ValueChanged<bool>? onBusyChanged;
  final Future<void> Function() onChanged;
  final bool allowConfirm;
  @override
  State<DoseCard> createState() => _DoseCardState();
}

class _DoseCardState extends State<DoseCard> {
  bool busy = false;
  Future<void> confirm(String status) async {
    if (busy) return;
    if (status == 'skipped' &&
        !await confirmAction(context,
            title: 'Record as skipped?',
            message: 'The shared record will show that you skipped this dose.',
            confirm: 'Record skipped')) {
      return;
    }
    if (!mounted) return;
    setState(() => busy = true);
    widget.onBusyChanged?.call(true);
    try {
      if (status == 'snooze') {
        await widget.repo.snoozeDose(widget.patient.id, widget.dose.id);
      } else {
        await widget.repo
            .confirmDose(widget.patient.id, widget.dose.id, status);
      }
    } catch (e) {
      if (mounted) {
        if (e is ApiException && e.status == 409) {
          final saved = e.data['dose'] as Json?;
          final savedStatus = saved?['status'] as String?;
          notice(
              context,
              savedStatus == 'taken' || savedStatus == 'skipped'
                  ? 'Already $savedStatus${saved?['confirmed_by_name'] == null ? '' : ' by ${saved!['confirmed_by_name']}'}. The saved confirmation was kept.'
                  : e.message);
        } else {
          notice(context, friendlyError(e));
        }
      }
    } finally {
      widget.onBusyChanged?.call(false);
      if (mounted) {
        setState(() => busy = false);
        await widget.onChanged();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final dose = widget.dose;
    final color = switch (dose.status) {
      'taken' => teal,
      'missed' => const Color(0xFF9D4B31),
      'skipped' => muted,
      _ => const Color(0xFF936925)
    };
    final status = dose.status == 'pending' && !dose.actionable
        ? 'Not active'
        : '${dose.status[0].toUpperCase()}${dose.status.substring(1)}';
    return Panel(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Wrap(
          spacing: 20,
          runSpacing: 10,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(patientTime(dose.scheduledFor, widget.patient.timezone),
                style: Theme.of(context).textTheme.titleLarge),
            StatusBadge(status,
                color: color,
                icon: dose.status == 'taken'
                    ? Icons.check_circle_outline
                    : Icons.schedule),
          ]),
      const SizedBox(height: 16),
      Text(dose.medicine, style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 4),
      Text(dose.amount),
      if (dose.snoozedUntil != null && dose.status == 'pending') ...[
        const SizedBox(height: 10),
        Text(
            'Snoozed until ${patientTime(dose.snoozedUntil!, widget.patient.timezone)}. The missed-dose deadline stays the same.'),
      ],
      if (dose.status == 'missed') ...[
        const SizedBox(height: 10),
        const Text(
            'No confirmation was recorded within 45 minutes. If it was given, record the actual outcome below.'),
      ],
      if (dose.confirmedAt != null) ...[
        const SizedBox(height: 10),
        Text(
            'Recorded${dose.confirmedBy == null ? '' : ' by ${dose.confirmedBy}'} at ${patientTime(dose.confirmedAt!, widget.patient.timezone)}')
      ],
      if (dose.status == 'pending' && !dose.actionable) ...[
        const SizedBox(height: 10),
        const Text('The original schedule is no longer active.')
      ],
      if (widget.patient.role.canConfirm &&
          (dose.status == 'pending' || dose.status == 'missed') &&
          dose.actionable &&
          widget.allowConfirm) ...[
        const SizedBox(height: 20),
        Wrap(spacing: 12, runSpacing: 8, children: [
          FilledButton.icon(
              onPressed: busy ? null : () => confirm('taken'),
              icon: busy
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.check, size: 19),
              label: const Text('Taken')),
          OutlinedButton(
              onPressed: busy ? null : () => confirm('skipped'),
              child: const Text('Skip')),
          if (dose.canSnooze)
            OutlinedButton.icon(
                onPressed: busy ? null : () => confirm('snooze'),
                icon: const Icon(Icons.snooze, size: 19),
                label: const Text('Snooze 10 min')),
        ]),
      ],
    ]));
  }
}
