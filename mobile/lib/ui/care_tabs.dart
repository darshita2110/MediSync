import 'package:flutter/material.dart';
import '../api.dart';
import '../models.dart';
import 'shared.dart';

class ReviewTab extends StatefulWidget {
  const ReviewTab({super.key, required this.patient, required this.repo});
  final Patient patient;
  final Repository repo;
  @override
  State<ReviewTab> createState() => _ReviewTabState();
}

class _ReviewTabState extends State<ReviewTab> {
  late Future<List<Conflict>> future;
  String status = 'open';
  @override
  void initState() {
    super.initState();
    future = load();
  }

  Future<List<Conflict>> load() =>
      widget.repo.conflicts(widget.patient.id, status: status);
  Future<void> refresh() async {
    setState(() {
      future = load();
    });
    try {
      await future;
    } catch (_) {}
  }

  Future<void> close(Conflict conflict, String value) async {
    if (!await confirmAction(context,
        title: value == 'resolved'
            ? 'Mark this review resolved?'
            : 'Dismiss this finding?',
        message:
            'This updates the review record only. It does not change a prescription or dose schedule.',
        confirm: value == 'resolved' ? 'Mark resolved' : 'Dismiss')) {
      return;
    }
    try {
      await widget.repo.closeConflict(widget.patient.id, conflict.id, value);
    } finally {
      if (mounted) await refresh();
    }
  }

  @override
  Widget build(BuildContext context) =>
      ContentList(onRefresh: refresh, children: [
        SectionTitle('Prescription review',
            subtitle:
                'Bring questions about recorded medicines to the prescriber.',
            action: widget.patient.role.canManage
                ? RunButton(
                    label: 'Check medicines',
                    icon: Icons.fact_check_outlined,
                    outlined: true,
                    run: () async {
                      await widget.repo.checkConflicts(widget.patient.id);
                      if (mounted) await refresh();
                    })
                : null),
        Wrap(spacing: 8, children: [
          ChoiceChip(
              label: const Text('Open findings'),
              selected: status == 'open',
              onSelected: (_) {
                status = 'open';
                refresh();
              }),
          ChoiceChip(
              label: const Text('All history'),
              selected: status == 'all',
              onSelected: (_) {
                status = 'all';
                refresh();
              })
        ]),
        const SizedBox(height: 20),
        AsyncSection(
            future: future,
            retry: refresh,
            builder: (conflicts) => conflicts.isEmpty
                ? EmptyState(
                    title: status == 'open'
                        ? 'No open findings'
                        : 'No review history',
                    message:
                        'Checks compare the information recorded here. They do not replace a review with a doctor or pharmacist.',
                    icon: Icons.fact_check_outlined)
                : Column(children: [
                    for (final conflict in conflicts)
                      Padding(
                          padding: const EdgeInsets.only(bottom: 16),
                          child: Panel(
                              child: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
                                  children: [
                                Wrap(spacing: 10, runSpacing: 8, children: [
                                  StatusBadge(conflict.status,
                                      color: conflict.status == 'open'
                                          ? const Color(0xFF936925)
                                          : teal),
                                  StatusBadge('Level ${conflict.level}')
                                ]),
                                const SizedBox(height: 16),
                                Text(conflict.title,
                                    style: Theme.of(context)
                                        .textTheme
                                        .titleMedium),
                                const SizedBox(height: 8),
                                Text(conflict.description,
                                    style:
                                        Theme.of(context).textTheme.bodyLarge),
                                if (widget.patient.role.canManage &&
                                    conflict.status == 'open') ...[
                                  const SizedBox(height: 20),
                                  Wrap(spacing: 12, runSpacing: 10, children: [
                                    RunButton(
                                        label: 'Mark resolved',
                                        icon: Icons.check,
                                        run: () => close(conflict, 'resolved')),
                                    RunButton(
                                        label: 'Dismiss',
                                        icon: Icons.close,
                                        outlined: true,
                                        run: () =>
                                            close(conflict, 'dismissed')),
                                  ])
                                ],
                              ])))
                  ])),
      ]);
}

class PeopleTab extends StatefulWidget {
  const PeopleTab({super.key, required this.patient, required this.repo});
  final Patient patient;
  final Repository repo;
  @override
  State<PeopleTab> createState() => _PeopleTabState();
}

class _PeopleTabState extends State<PeopleTab> {
  late Future<List<Caregiver>> future;
  @override
  void initState() {
    super.initState();
    future = widget.repo.caregivers(widget.patient.id);
  }

  Future<void> refresh() async {
    setState(() {
      future = widget.repo.caregivers(widget.patient.id);
    });
    try {
      await future;
    } catch (_) {}
  }

  Future<void> invite() async {
    if (await showDialog<bool>(
                context: context,
                barrierDismissible: false,
                builder: (_) =>
                    InviteDialog(patient: widget.patient, repo: widget.repo)) ==
            true &&
        mounted) {
      await refresh();
    }
  }

  @override
  Widget build(BuildContext context) =>
      ContentList(onRefresh: refresh, children: [
        SectionTitle('People in this care space',
            subtitle: 'Access is shared by invitation and acceptance.',
            action: widget.patient.role == PatientRole.owner
                ? FilledButton.icon(
                    onPressed: invite,
                    icon: const Icon(Icons.person_add_alt),
                    label: const Text('Invite caregiver'))
                : null),
        AsyncSection(
            future: future,
            retry: refresh,
            builder: (people) => Column(children: [
                  for (final person in people)
                    Padding(
                        padding: const EdgeInsets.only(bottom: 14),
                        child: Panel(
                            child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                              Text(person.name ?? person.email,
                                  style:
                                      Theme.of(context).textTheme.titleMedium),
                              const SizedBox(height: 4),
                              SelectableText(person.email),
                              const SizedBox(height: 14),
                              Wrap(spacing: 10, runSpacing: 8, children: [
                                StatusBadge(person.role.label),
                                StatusBadge(
                                    person.status == 'pending'
                                        ? 'Awaiting acceptance'
                                        : 'Accepted',
                                    color: person.status == 'pending'
                                        ? const Color(0xFF936925)
                                        : teal)
                              ]),
                              if (widget.patient.role == PatientRole.owner &&
                                  person.role != PatientRole.owner) ...[
                                const SizedBox(height: 16),
                                RunButton(
                                    label: person.status == 'pending'
                                        ? 'Cancel invitation'
                                        : 'Remove access',
                                    outlined: true,
                                    icon: Icons.person_remove_outlined,
                                    run: () async {
                                      if (!await confirmAction(context,
                                          title: 'Remove this access?',
                                          message:
                                              '${person.name ?? person.email} will no longer be able to open this patient’s care space.',
                                          confirm: 'Remove access')) {
                                        return;
                                      }
                                      await widget.repo
                                          .revoke(widget.patient.id, person.id);
                                      if (mounted) await refresh();
                                    })
                              ],
                            ])))
                ])),
      ]);
}

class InviteDialog extends StatefulWidget {
  const InviteDialog({super.key, required this.patient, required this.repo});
  final Patient patient;
  final Repository repo;
  @override
  State<InviteDialog> createState() => _InviteDialogState();
}

class _InviteDialogState extends State<InviteDialog> {
  final form = GlobalKey<FormState>();
  final email = TextEditingController();
  PatientRole role = PatientRole.helper;
  bool busy = false;
  String? error;
  @override
  void dispose() {
    email.dispose();
    super.dispose();
  }

  Future<void> save() async {
    if (!form.currentState!.validate()) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.repo
          .invite(widget.patient.id, email.text.trim(), roleValue(role));
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => error = friendlyError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => FormDialog(
          title: 'Invite a caregiver',
          subtitle:
              'They need a MediSync account. The invitation will appear in their app and grants access only after they accept.',
          formKey: form,
          busy: busy,
          error: error,
          onSave: save,
          saveLabel: 'Create invitation',
          children: [
            TextFormField(
                controller: email,
                keyboardType: TextInputType.emailAddress,
                decoration:
                    const InputDecoration(labelText: 'Their email address'),
                validator: (value) => value != null &&
                        RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
                            .hasMatch(value.trim())
                    ? null
                    : 'Enter a valid email address'),
            DropdownButtonFormField<PatientRole>(
                value: role,
                decoration: const InputDecoration(labelText: 'Access level'),
                items: [
                  for (final value in [
                    PatientRole.familyAdmin,
                    PatientRole.helper,
                    PatientRole.viewer
                  ])
                    DropdownMenuItem(value: value, child: Text(value.label)),
                ],
                onChanged: (value) => setState(() => role = value!)),
            Text(switch (role) {
              PatientRole.familyAdmin =>
                'Can read records, manage medicines and schedules, and record doses.',
              PatientRole.helper =>
                'Can see today’s schedule and record today’s doses.',
              _ =>
                'Can read medical records and timelines. Cannot change them.',
            }),
          ]);
}
