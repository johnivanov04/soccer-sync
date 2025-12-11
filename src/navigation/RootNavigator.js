import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useAuth } from "../context/AuthContext";

import CreateMatchScreen from "../screens/CreateMatchScreen";
import MatchDetailScreen from "../screens/MatchDetailScreen";
import MatchesListScreen from "../screens/MatchesListScreen";
import ProfileScreen from "../screens/ProfileScreen";
import SignInScreen from "../screens/SignInScreen";
import SignUpScreen from "../screens/SignUpScreen";
import StatsScreen from "../screens/StatsScreen";
import TeamsScreen from "../screens/TeamsScreen";

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const MatchesStack = () => (
  <Stack.Navigator>
    <Stack.Screen name="MatchesList" component={MatchesListScreen} options={{ title: "Matches" }} />
    <Stack.Screen name="MatchDetail" component={MatchDetailScreen} options={{ title: "Match" }} />
    <Stack.Screen name="CreateMatch" component={CreateMatchScreen} options={{ title: "Create Match" }} />
  </Stack.Navigator>
);

const AppTabs = () => (
  <Tab.Navigator>
    <Tab.Screen name="Matches" component={MatchesStack} options={{ headerShown: false }} />
    <Tab.Screen name="Teams" component={TeamsScreen} />
    <Tab.Screen name="Stats" component={StatsScreen} />
    <Tab.Screen name="Profile" component={ProfileScreen} />
  </Tab.Navigator>
);

const AuthStack = () => (
  <Stack.Navigator>
    <Stack.Screen name="SignIn" component={SignInScreen} options={{ title: "Sign In" }} />
    <Stack.Screen name="SignUp" component={SignUpScreen} options={{ title: "Sign Up" }} />
  </Stack.Navigator>
);

const RootNavigator = () => {
  const { user, initializing } = useAuth();

  if (initializing) {
    return null; // TODO: splash screen
  }

  return user ? <AppTabs /> : <AuthStack />;
};

export default RootNavigator;
