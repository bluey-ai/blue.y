{{/*
Expand the name of the chart.
*/}}
{{- define "blue-y.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "blue-y.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Chart labels
*/}}
{{- define "blue-y.labels" -}}
helm.sh/chart: {{ include "blue-y.chart" . }}
{{ include "blue-y.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "blue-y.selectorLabels" -}}
app.kubernetes.io/name: {{ include "blue-y.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Chart name + version for helm.sh/chart label
*/}}
{{- define "blue-y.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "blue-y.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "blue-y.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Secret name — either the user-supplied existing secret or the chart-managed one.
*/}}
{{- define "blue-y.secretName" -}}
{{- if .Values.existingSecret.name }}
{{- .Values.existingSecret.name }}
{{- else }}
{{- include "blue-y.fullname" . }}-secrets
{{- end }}
{{- end }}
