import { ApolloProvider, gql, useMutation } from "@apollo/client";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { apolloClient, getQueueLength, setForcedOffline as setLinkForcedOffline } from "./src/apollo";

const CREATE_POST = gql`
  mutation CreatePost($title: String!, $body: String!) {
    createPost(input: { title: $title, body: $body }) {
      id
      title
    }
  }
`;

function DemoScreen() {
  const [queueLength, setQueueLength] = useState(0);
  const [statusMessage, setStatusMessage] = useState("Idle");
  const [forcedOffline, setForcedOffline] = useState(false);
  const [createPost, { loading }] = useMutation(CREATE_POST);

  useEffect(() => {
    const id = setInterval(() => {
      setQueueLength(getQueueLength());
    }, 300);

    return () => clearInterval(id);
  }, []);

  const payload = useMemo(
    () => ({
      title: `Offline demo ${Date.now()}`,
      body: "Queued mutation",
    }),
    [],
  );

  const handlePress = async () => {
    setStatusMessage("Sending mutation...");
    try {
      const result = await createPost({ variables: payload });
      if (result.data) {
        setStatusMessage(`Sent: ${result.data.createPost.title}`);
      } else {
        setStatusMessage("Queued (no response yet)");
      }
    } catch (error) {
      setStatusMessage("Queued (offline/network error)");
    }
  };

  const handleToggleOffline = () => {
    const next = !forcedOffline;
    setForcedOffline(next);
    setLinkForcedOffline(next);
    setStatusMessage(next ? "Forced offline" : "Back online");
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Apollo Offline Queue Demo</Text>
      <Text style={styles.meta}>Retry ops: CreatePost</Text>
      <Text style={styles.subtitle}>Queued mutations: {queueLength}</Text>
      <Pressable style={styles.button} onPress={handlePress} disabled={loading}>
        <Text style={styles.buttonText}>
          {loading ? "Sending..." : "Send Mutation"}
        </Text>
      </Pressable>
      <Pressable
        style={[styles.button, styles.secondaryButton]}
        onPress={handleToggleOffline}
      >
        <Text style={[styles.buttonText, styles.secondaryButtonText]}>
          {forcedOffline ? "Go Online" : "Go Offline"}
        </Text>
      </Pressable>
      <Text style={styles.status}>{statusMessage}</Text>
      <StatusBar style="auto" />
    </View>
  );
}

export default function App() {
  return (
    <ApolloProvider client={apolloClient}>
      <DemoScreen />
    </ApolloProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 8,
  },
  subtitle: {
    color: "#cbd5f5",
    marginBottom: 16,
  },
  meta: {
    color: "#94a3b8",
    marginBottom: 4,
  },
  button: {
    backgroundColor: "#38bdf8",
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 8,
    marginBottom: 16,
  },
  buttonText: {
    color: "#0f172a",
    fontWeight: "700",
  },
  secondaryButton: {
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#38bdf8",
  },
  secondaryButtonText: {
    color: "#e2e8f0",
  },
  status: {
    color: "#e2e8f0",
    textAlign: "center",
  },
});
